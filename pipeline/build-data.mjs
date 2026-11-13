// 이 집 얼마 들어? — 실거래 데이터 수집·집계 스크립트
//
// 하는 일
//   1) 공공데이터포털 '국토교통부_아파트 매매 실거래가 상세 자료' API를 시군구(regions.json)·월별로 호출
//      - 월별 원본 응답은 pipeline/cache/{LAWD_CD}/{YYYYMM}.json 에 저장하고 재사용
//      - 매일: 최근 3개월만 다시 받음 · 매달 1일(한국 시간): 12개월 전체 다시 받음 (늦게 들어온 해제거래 반영)
//      - 캐시가 없는 달은 받음 → 첫 실행이 곧 백필. 하루 호출 한도에 닿으면 멈추고 다음 실행에서 이어 받음
//   2) 해제 거래(cdealType = 'O') 제외
//   3) 단지(aptSeq) → 전용면적 타입(소수점 버림)별로 평균·건수·마지막 거래·층 범위 계산
//      12개월이 다 모인 시군구만 결과에 넣음 (일부 달만으로 평균을 내지 않음)
//   4) 단지 좌표는 pipeline/apt-points.json (points.mjs) 에서 붙임. 좌표 없는 단지는 지도에서 뺌
//   5) data/index.json (시군구 목록·중심·범위·단지 수) + data/complexes/{LAWD_CD}.json (시군구별 단지)
//
// 실행: node pipeline/build-data.mjs [--max-calls N] [--full]
//   --max-calls N : 이번 실행의 HTTP 호출 상한 (하루 상한 DAILY_CALL_LIMIT 과 별개로 더 작게 제한)
//   --full        : 오늘이 1일이 아니어도 12개월 전체를 다시 받음
//   인증키는 저장소 루트의 .env (DATA_GO_KR_KEY=...) 에서 읽음.
//   이미 설정된 환경변수(GitHub Actions Secrets 등)가 있으면 그쪽이 우선.
// 필요: Node 18 이상 (fetch 내장)

import { readFile, writeFile, mkdir, rename, readdir, rm, appendFile, open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPoints } from "./points.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- .env ----------
// 외부 패키지 없이 KEY=VALUE 줄만 읽음. 파일이 없으면 조용히 넘어감 (CI 는 Secrets 사용).
function loadDotEnv(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv(join(ROOT, ".env"));

const CONFIG_PATH = join(ROOT, "pipeline", "config.json");
const REGIONS_PATH = process.env.REGIONS_PATH || join(ROOT, "pipeline", "regions.json");
const CACHE_DIR = process.env.CACHE_DIR || join(ROOT, "pipeline", "cache");
const USAGE_PATH = join(CACHE_DIR, "usage.json");      // 날짜(한국 시간)별 누적 호출 수
const RUNLOG_PATH = join(CACHE_DIR, "runs.jsonl");     // 실행마다 한 줄 요약
const POINTS_PATH = process.env.POINTS_PATH || join(ROOT, "pipeline", "apt-points.json");
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const INDEX_PATH = join(DATA_DIR, "index.json");
const REGION_DIR = join(DATA_DIR, "complexes");

const RTMS_URL = process.env.RTMS_URL ||
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";
const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY; // 공공데이터포털 '일반 인증키(Decoding)'
const PAGE_SIZE = 1000;
const DAILY_CALL_LIMIT = Number(process.env.DAILY_CALL_LIMIT) || 9000; // 개발계정 10,000 중 1,000은 여유
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 4);
const REQUEST_GAP_MS = Number(process.env.REQUEST_GAP_MS ?? 150);
const SOURCE_TEXT = "국토교통부 아파트 매매 실거래가 상세 자료 (공공데이터포털)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- 날짜 (한국 시간) ----------
const nowDate = () => (process.env.NOW ? new Date(process.env.NOW) : new Date()); // NOW 는 테스트용
const kst = (d) => new Date(d.getTime() + 9 * 3600 * 1000);
const kstDay = (d) => kst(d).toISOString().slice(0, 10);

export function recentMonths(n, now = nowDate()) {
  // 한국 시간 기준 이번 달부터 n개월 (YYYYMM)
  const k = kst(now);
  let y = k.getUTCFullYear(), m = k.getUTCMonth() + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

// ---------- 호출 예산 ----------
class StopFetching extends Error {}   // 한도 도달: 받기만 멈추고 결과는 만듦
class FatalApiError extends Error {}  // 인증키 오류 등: 전체 실패

class CallBudget {
  constructor(limit) { this.limit = limit; this.used = 0; }
  take() {
    if (this.used >= this.limit) throw new StopFetching("이번 실행 호출 상한에 닿았어요");
    this.used++;
  }
}

// ---------- 실거래 API ----------
const QUOTA_CODES = new Set(["22"]);                       // LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR
const FATAL_CODES = new Set(["20", "30", "31", "32", "33"]); // 접근 거부·키 미등록·기한 만료·IP·서명 오류

function classifyHeader(code, msg, label) {
  code = String(code);
  if (QUOTA_CODES.has(code) || /LIMITED_NUMBER/i.test(msg)) throw new StopFetching(`API 하루 한도 초과 (${code})`);
  if (FATAL_CODES.has(code) || /SERVICE_KEY|SERVICE_ACCESS_DENIED|DEADLINE/i.test(msg)) throw new FatalApiError(`${label}: ${code} ${msg}`);
  throw new Error(`${label}: ${code} ${msg}`);
}

async function fetchJson(url, label, budget, stats, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    budget.take();
    stats.calls++;
    if (t > 1) stats.retries++;
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (!text.trim().startsWith("{")) {
        // 인증키·한도 오류 등은 XML로 옴
        const code = (text.match(/<returnReasonCode>([^<]+)/) || text.match(/<resultCode>([^<]+)/) || [])[1] || String(res.status);
        const msg = (text.match(/<returnAuthMsg>([^<]+)/) || text.match(/<resultMsg>([^<]+)/) || [])[1] || "JSON 아님";
        classifyHeader(code, msg, label);
      }
      return JSON.parse(text);
    } catch (e) {
      if (e instanceof StopFetching || e instanceof FatalApiError || t === tries) throw e;
      await sleep(1000 * t);
    }
  }
}

function asArray(items) {
  if (!items || items === "") return [];
  const it = items.item;
  if (!it) return [];
  return Array.isArray(it) ? it : [it];
}

async function fetchMonth(lawdCd, ym, budget, stats) {
  const all = [];
  let total = 0, pages = 0;
  for (let page = 1; page < 100; page++) {
    const url = `${RTMS_URL}?serviceKey=${encodeURIComponent(DATA_GO_KR_KEY)}&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&pageNo=${page}&numOfRows=${PAGE_SIZE}&_type=json`;
    const json = await fetchJson(url, `${lawdCd}/${ym} p${page}`, budget, stats);
    const header = json?.response?.header || {};
    if (header.resultCode && !["00", "000"].includes(String(header.resultCode))) {
      classifyHeader(header.resultCode, header.resultMsg || "", `${lawdCd}/${ym}`);
    }
    const body = json?.response?.body || {};
    const items = asArray(body.items);
    all.push(...items);
    pages = page;
    total = Number(body.totalCount) || 0;
    if (all.length >= total || items.length === 0) break;
    await sleep(REQUEST_GAP_MS);
  }
  return { items: all, totalCount: total, pages };
}

// ---------- 원본 캐시 ----------
const cachePath = (lawdCd, ym) => join(CACHE_DIR, lawdCd, `${ym}.json`);

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
async function writeJsonAtomic(path, data) {
  // 중간에 끊겨도 깨진 파일이 남지 않게 임시 파일에 쓴 뒤 이름 바꾸기
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, path);
}
async function cacheMeta(lawdCd, ym) {
  // 받은 시각만 필요하므로 파일 앞부분(fetchedAt 은 items 앞에 씀)만 읽음
  let fh;
  try {
    fh = await open(cachePath(lawdCd, ym), "r");
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(256), 0, 256, 0);
    const m = buffer.subarray(0, bytesRead).toString("utf8").match(/"fetchedAt":"([^"]+)"/);
    return m ? { fetchedDay: kstDay(new Date(m[1])) } : null;
  } catch { return null; } finally { await fh?.close(); }
}

// 12개월 범위 밖의 달 캐시 지우기
async function pruneCache(regions, months) {
  const keep = new Set(months);
  let removed = 0;
  for (const r of regions) {
    let files;
    try { files = await readdir(join(CACHE_DIR, r.lawdCd)); } catch { continue; }
    for (const f of files) {
      const ym = f.replace(/\.json$/, "");
      if (/^\d{6}$/.test(ym) && !keep.has(ym)) { await rm(join(CACHE_DIR, r.lawdCd, f), { force: true }); removed++; }
      else if (f.endsWith(".tmp")) await rm(join(CACHE_DIR, r.lawdCd, f), { force: true });
    }
  }
  return removed;
}

// 받을 달 정하기. 순서: ① 최근 달(빠진 것·갱신) ② 빠진 옛 달(백필) ③ 1일 전체 갱신
async function planFetches(regions, months, recent, fullRefresh, today) {
  const tiers = [[], [], []];
  let fromCache = 0;
  for (const r of regions) {
    for (const ym of months) {
      const meta = await cacheMeta(r.lawdCd, ym);
      const isRecent = recent.has(ym);
      const fetchedToday = meta?.fetchedDay === today;
      if (!meta) tiers[isRecent ? 0 : 1].push({ region: r, ym, reason: "missing" });
      else if (isRecent && !fetchedToday) tiers[0].push({ region: r, ym, reason: "recent" });
      else if (fullRefresh && !fetchedToday) tiers[2].push({ region: r, ym, reason: "full" });
      else fromCache++;
    }
  }
  return { jobs: tiers.flat(), fromCache };
}

async function runFetches(jobs, budget, stats) {
  let next = 0, stop = null, fatal = null;
  const worker = async () => {
    while (!stop && !fatal && next < jobs.length) {
      const job = jobs[next++];
      const { region, ym } = job;
      try {
        const res = await fetchMonth(region.lawdCd, ym, budget, stats);
        await writeJsonAtomic(cachePath(region.lawdCd, ym), {
          lawdCd: region.lawdCd, ym, fetchedAt: nowDate().toISOString(), totalCount: res.totalCount, pages: res.pages, items: res.items
        });
        stats.monthsFetched++;
        stats.byReason[job.reason] = (stats.byReason[job.reason] || 0) + 1;
        if (process.env.VERBOSE) log(`  ${region.label} ${ym}: ${res.items.length}건 (${res.pages}쪽)`);
      } catch (e) {
        if (e instanceof StopFetching) { stop = e; break; }
        if (e instanceof FatalApiError) { fatal = e; break; }
        stats.failed.push(`${region.label} ${ym}: ${e.message}`);
      }
      await sleep(REQUEST_GAP_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return { stop, fatal, skipped: jobs.length - stats.monthsFetched - stats.failed.length };
}

// ---------- 정규화·집계 ----------
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const toInt = (v) => parseInt(str(v).replace(/,/g, ""), 10);

function normalize(raw, region) {
  const area = parseFloat(str(raw.excluUseAr));
  const price = toInt(raw.dealAmount);
  const y = toInt(raw.dealYear), m = toInt(raw.dealMonth), d = toInt(raw.dealDay);
  if (!area || !price || !y || !m || !d) return null;
  const umdNm = str(raw.umdNm), jibun = str(raw.jibun), aptNm = str(raw.aptNm);
  return {
    key: str(raw.aptSeq) || `${region.lawdCd}-${umdNm}-${jibun}-${aptNm}`,
    aptNm, umdNm, jibun,
    buildYear: toInt(raw.buildYear) || null,
    areaType: Math.floor(area),
    price,
    date: `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}`,
    floor: Number.isFinite(toInt(raw.floor)) ? toInt(raw.floor) : null,
    canceled: str(raw.cdealType) === "O"
  };
}

export function aggregate(trades, region, period) {
  const byComplex = new Map();
  for (const t of trades) {
    if (!byComplex.has(t.key)) byComplex.set(t.key, []);
    byComplex.get(t.key).push(t);
  }
  const complexes = [];
  for (const [key, list] of byComplex) {
    list.sort((a, b) => b.date.localeCompare(a.date));
    const latest = list[0];
    const byArea = new Map();
    for (const t of list) {
      if (!byArea.has(t.areaType)) byArea.set(t.areaType, []);
      byArea.get(t.areaType).push(t);
    }
    const areas = [...byArea.entries()].sort((a, b) => a[0] - b[0]).map(([areaM2, txs]) => {
      const floors = txs.map((t) => t.floor).filter((f) => f !== null);
      return {
        areaM2,
        supplyPyeong: Math.round(areaM2 * 0.4),           // 공급면적은 API에 없어 근사치
        avgPriceManwon: Math.round(txs.reduce((s, t) => s + t.price, 0) / txs.length),
        txCount12m: txs.length,
        periodLabel: `최근 ${period.months}개월 실거래 평균`,
        lastTxDate: txs[0].date,
        lastTxPriceManwon: txs[0].price,
        lastTxFloor: txs[0].floor !== null ? `${txs[0].floor}층` : "-",
        floorRange: floors.length ? `${Math.min(...floors)}층 ~ ${Math.max(...floors)}층` : "-",
        lowTxRecords: txs.length < 3
          ? txs.map((t) => ({ date: t.date, priceManwon: t.price, floor: t.floor !== null ? `${t.floor}층` : "-", note: "개별 거래" }))
          : []
      };
    });
    complexes.push({
      id: key,
      name: latest.aptNm,
      region: region.label,
      lawdCd: region.lawdCd,
      address: [region.sido, region.sigungu, latest.umdNm, latest.jibun].filter(Boolean).join(" "),
      builtYear: latest.buildYear,
      areas
    });
  }
  return complexes;
}

// ---------- 시군구 중심·범위 ----------
const round = (v, d = 5) => Math.round(v * 10 ** d) / 10 ** d;
export function centerAndBbox(points) {
  if (!points.length) return { center: null, bbox: null };
  let lat = 0, lng = 0, s = 90, w = 180, n = -90, e = -180;
  for (const p of points) {
    lat += p.lat; lng += p.lng;
    s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng);
  }
  return { center: [round(lat / points.length), round(lng / points.length)], bbox: [round(s), round(w), round(n), round(e)] };
}

// ---------- 실행 ----------
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!DATA_GO_KR_KEY) throw new Error("DATA_GO_KR_KEY 환경변수가 없어요 (공공데이터포털 일반 인증키, Decoding)");

  const startedAt = nowDate();
  const today = kstDay(startedAt);
  const config = await readJson(CONFIG_PATH, null);
  const { regions } = await readJson(REGIONS_PATH, { regions: [] });
  if (!regions.length) throw new Error(`시군구 목록이 비어 있어요: ${REGIONS_PATH}`);
  const months = recentMonths(config.months, startedAt);
  const recent = new Set(months.slice(0, config.recentMonths ?? 3));
  const fullRefresh = process.argv.includes("--full") || kst(startedAt).getUTCDate() === 1;
  const period = { months: config.months, from: months.at(-1), to: months[0] };

  // 오늘 이미 쓴 호출 수를 빼고 남은 만큼만
  const usage = await readJson(USAGE_PATH, {});
  const usedBefore = usage[today] || 0;
  // --max-calls 0 은 '받지 않고 캐시로만 집계' (좌표 파일만 바꿨을 때 등)
  const maxCallsArg = argValue("--max-calls");
  const maxCalls = maxCallsArg !== undefined && /^\d+$/.test(maxCallsArg) ? Number(maxCallsArg) : Infinity;
  const budget = new CallBudget(Math.max(0, Math.min(maxCalls, DAILY_CALL_LIMIT - usedBefore)));
  const stats = { calls: 0, retries: 0, monthsFetched: 0, byReason: {}, failed: [], trades: 0, canceled: 0, complexes: 0, unmatched: [] };

  await mkdir(CACHE_DIR, { recursive: true });
  const pruned = await pruneCache(regions, months);
  const { jobs, fromCache } = await planFetches(regions, months, recent, fullRefresh, today);
  log(`시군구 ${regions.length}곳 × ${months.length}개월 (${period.from}~${period.to}) · ${fullRefresh ? "전체 갱신일" : "최근 " + recent.size + "개월 갱신"}`);
  log(`받을 달 ${jobs.length}개 (빠진 달 ${jobs.filter((j) => j.reason === "missing").length}) · 캐시 사용 ${fromCache}개 · 오늘 이미 쓴 호출 ${usedBefore}회 · 이번 상한 ${budget.limit}회`);

  let stop = null, fatal = null, skipped = 0;
  try {
    ({ stop, fatal, skipped } = await runFetches(jobs, budget, stats));
  } finally {
    usage[today] = usedBefore + stats.calls;
    for (const d of Object.keys(usage)) if (d < kstDay(new Date(startedAt.getTime() - 40 * 864e5))) delete usage[d];
    await writeJsonAtomic(USAGE_PATH, usage);
  }
  if (fatal) throw fatal;

  // 집계: 12개월이 다 모인 시군구만 → 시군구별 파일 + index
  const points = await loadPoints(POINTS_PATH);
  const updatedAt = new Date().toISOString();
  const index = [];
  const written = new Set();
  const pending = [];
  let mapped = 0;
  await mkdir(REGION_DIR, { recursive: true });
  for (const region of regions) {
    const raws = [];
    let complete = true, lastFetched = null;
    for (const ym of months) {
      const c = await readJson(cachePath(region.lawdCd, ym), null);
      if (!c) { complete = false; break; }
      raws.push(c.items);
      if (!lastFetched || c.fetchedAt > lastFetched) lastFetched = c.fetchedAt;
    }
    const base = { lawdCd: region.lawdCd, sido: region.sido, sigungu: region.sigungu, label: region.label };
    if (!complete) {
      pending.push(region.label);
      index.push({ ...base, center: null, bbox: null, complexes: 0, mapped: 0, trades: 0, updatedAt: null, status: "pending" });
      continue;
    }
    const trades = [];
    for (const items of raws) for (const r of items) {
      const t = normalize(r, region);
      if (!t) continue;
      if (t.canceled) { stats.canceled++; continue; }
      trades.push(t);
    }
    stats.trades += trades.length;
    const complexes = aggregate(trades, region, period);
    const withCoords = [];
    for (const c of complexes) {
      const p = points.get(c.id);
      if (!p) { stats.unmatched.push(`${region.label} ${c.name} (${c.address})`); continue; }
      withCoords.push({ ...c, lat: p.lat, lng: p.lng });
    }
    stats.complexes += complexes.length;
    mapped += withCoords.length;
    const file = `${region.lawdCd}.json`;
    await writeJsonAtomic(join(REGION_DIR, file), { lawdCd: region.lawdCd, label: region.label, updatedAt: lastFetched, period, complexes: withCoords });
    written.add(file);
    index.push({
      ...base, ...centerAndBbox(withCoords),
      complexes: complexes.length, mapped: withCoords.length, trades: trades.length,
      updatedAt: lastFetched, status: "ok"
    });
  }
  // 이번에 만들지 않은 시군구 파일(목록에서 빠졌거나 pending 으로 돌아간 곳)과 예전 단일 파일 지우기
  for (const f of await readdir(REGION_DIR)) if (!written.has(f)) await rm(join(REGION_DIR, f), { force: true });
  await rm(join(DATA_DIR, "complexes.json"), { force: true });
  await writeJsonAtomic(INDEX_PATH, {
    updatedAt,
    period,
    source: points.source ? `${SOURCE_TEXT} · 좌표: ${points.source}` : SOURCE_TEXT,
    regions: index
  });
  const out = { length: mapped };

  // 백필이 얼마나 남았는지 (다음 실행에서 받을 빠진 달)
  const missingAfter = jobs.filter((j) => j.reason === "missing").length - (stats.byReason.missing || 0);

  const summary = {
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), day: today,
    mode: fullRefresh ? "full" : "daily",
    calls: stats.calls, retries: stats.retries, callsToday: usage[today], dailyLimit: DAILY_CALL_LIMIT,
    monthsFetched: stats.monthsFetched, byReason: stats.byReason, monthsFromCache: fromCache, monthsPruned: pruned,
    stoppedEarly: stop ? stop.message : null, jobsSkipped: skipped, failedMonths: stats.failed.length,
    backfillRemaining: missingAfter,
    regionsComplete: regions.length - pending.length, regionsPending: pending.length,
    trades: stats.trades, canceled: stats.canceled, complexes: stats.complexes, mapped: out.length, unmatched: stats.unmatched.length
  };
  await appendFile(RUNLOG_PATH, JSON.stringify(summary) + "\n");

  log(`\n호출: 이번 실행 ${stats.calls}회 (재시도 ${stats.retries}) · 오늘 누적 ${usage[today]}회 / 상한 ${DAILY_CALL_LIMIT}회`);
  log(`달: 새로 받음 ${stats.monthsFetched} (${Object.entries(stats.byReason).map(([k, v]) => `${{ missing: "빠진 달", recent: "최근", full: "전체 갱신" }[k]} ${v}`).join(", ") || "-"}) · 캐시 ${fromCache} · 범위 밖 삭제 ${pruned}`);
  if (stop) log(`멈춤: ${stop.message} → 못 받은 달 ${skipped}개는 다음 실행에서 이어 받아요`);
  if (stats.failed.length) log(`실패한 달 ${stats.failed.length}개 (다음 실행에서 다시 시도):\n - ${stats.failed.slice(0, 20).join("\n - ")}`);
  log(`백필 남은 달: ${missingAfter}개 · 결과에 넣은 시군구 ${regions.length - pending.length}곳 / 12개월이 덜 모인 시군구 ${pending.length}곳`);
  log(`완료: 유효 거래 ${stats.trades}건 (해제 ${stats.canceled}건 제외), 단지 ${stats.complexes}곳`);
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : "0.0");
  log(`좌표 매칭: ${out.length} / ${stats.complexes}곳 (${pct(out.length, stats.complexes)}%) · 실패 ${stats.unmatched.length}곳 (${pct(stats.unmatched.length, stats.complexes)}%)${points.size ? "" : " — apt-points.json 이 없어요"}`);
  const worst = index.filter((r) => r.status === "ok" && r.complexes > 0 && r.mapped < r.complexes)
    .sort((a, b) => a.mapped / a.complexes - b.mapped / b.complexes).slice(0, 10);
  if (worst.length) log(`매칭률 낮은 시군구: ${worst.map((r) => `${r.label} ${pct(r.mapped, r.complexes)}% (${r.complexes - r.mapped}곳 실패)`).join(" · ")}`);
  if (stats.unmatched.length && process.env.VERBOSE) log(` - ${stats.unmatched.slice(0, 50).join("\n - ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error("실패:", e.message); process.exit(1); });
}
