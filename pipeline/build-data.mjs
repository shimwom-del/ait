// 이 집 얼마 들어? — 실거래 데이터 수집·집계 스크립트
//
// 하는 일
//   1) 공공데이터포털 '국토교통부_아파트 매매 실거래가 상세 자료' API를 지역·월별로 호출
//   2) 해제 거래(cdealType = 'O') 제외
//   3) 단지(aptSeq) → 전용면적 타입(소수점 버림)별로 평균·건수·마지막 거래·층 범위 계산
//   4) 단지 좌표를 V-World 지오코더(공공데이터포털 '국토교통부_지오코더 API')로 찾고 캐시에 저장
//   5) data/complexes.json 으로 저장 → 앱이 이 파일 하나만 읽음
//
// 실행: node pipeline/build-data.mjs
//   인증키는 저장소 루트의 .env (DATA_GO_KR_KEY=..., VWORLD_KEY=...) 에서 읽음.
//   이미 설정된 환경변수(GitHub Actions Secrets 등)가 있으면 그쪽이 우선.
// 필요: Node 18 이상 (fetch 내장)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const GEO_CACHE_PATH = join(ROOT, "pipeline", "geo-cache.json");
const OUT_PATH = join(ROOT, "data", "complexes.json");

const RTMS_URL = process.env.RTMS_URL ||
  "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev";
const VWORLD_URL = process.env.VWORLD_URL || "https://api.vworld.kr/req/address";
const DATA_GO_KR_KEY = process.env.DATA_GO_KR_KEY; // 공공데이터포털 '일반 인증키(Decoding)'
const VWORLD_KEY = process.env.VWORLD_KEY;         // V-World 인증키
const PAGE_SIZE = 1000;
const GEO_RETRY_DAYS = 30;                          // 좌표를 못 찾은 단지는 30일 뒤 다시 시도

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- 날짜 ----------
function recentMonths(n, now = new Date()) {
  // 한국 시간 기준 이번 달부터 n개월 (YYYYMM)
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  let y = kst.getUTCFullYear(), m = kst.getUTCMonth() + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

// ---------- 실거래 API ----------
async function fetchJson(url, label, tries = 3) {
  for (let t = 1; t <= tries; t++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (!text.trim().startsWith("{")) {
        // 인증키 오류 등은 XML로 옴
        const msg = (text.match(/<returnAuthMsg>([^<]+)/) || text.match(/<resultMsg>([^<]+)/) || [])[1] || text.slice(0, 200);
        throw new Error(`${label}: JSON 아님 (${msg})`);
      }
      return JSON.parse(text);
    } catch (e) {
      if (t === tries) throw e;
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

async function fetchMonth(lawdCd, ymd) {
  const all = [];
  for (let page = 1; page < 100; page++) {
    const url = `${RTMS_URL}?serviceKey=${encodeURIComponent(DATA_GO_KR_KEY)}&LAWD_CD=${lawdCd}&DEAL_YMD=${ymd}&pageNo=${page}&numOfRows=${PAGE_SIZE}&_type=json`;
    const json = await fetchJson(url, `${lawdCd}/${ymd} p${page}`);
    const header = json?.response?.header || {};
    if (header.resultCode && !["00", "000"].includes(String(header.resultCode))) {
      throw new Error(`${lawdCd}/${ymd}: ${header.resultCode} ${header.resultMsg}`);
    }
    const body = json?.response?.body || {};
    const items = asArray(body.items);
    all.push(...items);
    const total = Number(body.totalCount) || 0;
    if (all.length >= total || items.length === 0) break;
    await sleep(150);
  }
  return all;
}

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

// ---------- 집계 ----------
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
      address: `${region.sido} ${region.sigungu} ${latest.umdNm} ${latest.jibun}`.trim(),
      geoQuery: `${region.sido} ${region.sigungu} ${latest.umdNm} ${latest.jibun}`.trim(),
      builtYear: latest.buildYear,
      areas
    });
  }
  return complexes;
}

// ---------- 좌표 (V-World 지오코더) ----------
async function geocode(address) {
  for (const type of ["parcel", "road"]) {
    const url = `${VWORLD_URL}?service=address&request=getcoord&version=2.0&crs=epsg:4326&refine=true&simple=false&format=json&type=${type}&address=${encodeURIComponent(address)}&key=${encodeURIComponent(VWORLD_KEY)}`;
    try {
      const json = await fetchJson(url, `geocode ${address}`, 2);
      const r = json?.response;
      if (r?.status === "OK" && r.result?.point) {
        const lng = parseFloat(r.result.point.x), lat = parseFloat(r.result.point.y);
        if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
      }
      if (r?.status === "ERROR") throw new Error(`V-World 오류: ${r.error?.text || JSON.stringify(r.error)}`);
    } catch (e) {
      if (String(e.message).includes("V-World 오류")) throw e;
    }
  }
  return null;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

// ---------- 실행 ----------
async function main() {
  if (!DATA_GO_KR_KEY) throw new Error("DATA_GO_KR_KEY 환경변수가 없어요 (공공데이터포털 일반 인증키, Decoding)");
  if (!VWORLD_KEY) throw new Error("VWORLD_KEY 환경변수가 없어요 (V-World 인증키)");

  const config = await readJson(CONFIG_PATH, null);
  const months = recentMonths(config.months);
  const period = { months: config.months, from: months.at(-1), to: months[0] };
  const geoCache = await readJson(GEO_CACHE_PATH, {});
  const stats = { calls: 0, trades: 0, canceled: 0, complexes: 0, geocoded: 0, unmatched: [] };
  const out = [];

  for (const region of config.regions) {
    const trades = [];
    for (const ymd of months) {
      const raw = await fetchMonth(region.lawdCd, ymd);
      stats.calls++;
      for (const r of raw) {
        const t = normalize(r, region);
        if (!t) continue;
        if (t.canceled) { stats.canceled++; continue; }
        trades.push(t);
      }
      log(`  ${region.label} ${ymd}: ${raw.length}건`);
      await sleep(150);
    }
    stats.trades += trades.length;
    const complexes = aggregate(trades, region, period);

    for (const c of complexes) {
      let geo = geoCache[c.id];
      const stale = geo?.failedAt && (Date.now() - Date.parse(geo.failedAt)) / 864e5 > GEO_RETRY_DAYS;
      if (!geo || stale) {
        const point = await geocode(c.geoQuery);
        geo = point ? { ...point, query: c.geoQuery } : { failedAt: new Date().toISOString(), query: c.geoQuery };
        geoCache[c.id] = geo;
        if (point) stats.geocoded++;
        await sleep(100);
      }
      if (geo.lat === undefined) { stats.unmatched.push(`${c.name} (${c.geoQuery})`); continue; }
      const { geoQuery, ...rest } = c;
      out.push({ ...rest, lat: geo.lat, lng: geo.lng });
    }
    stats.complexes += complexes.length;
    log(`${region.label}: 거래 ${trades.length}건 → 단지 ${complexes.length}곳`);
  }

  const result = {
    updatedAt: new Date().toISOString(),
    source: "국토교통부 아파트 매매 실거래가 상세 자료 (공공데이터포털), 좌표: V-World 지오코더",
    period,
    regions: config.regions.map(({ lawdCd, label }) => ({ lawdCd, label })),
    complexes: out
  };
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(result));
  await writeFile(GEO_CACHE_PATH, JSON.stringify(geoCache, null, 1));

  log(`\n완료: API 호출 ${stats.calls}회, 유효 거래 ${stats.trades}건 (해제 ${stats.canceled}건 제외), 단지 ${stats.complexes}곳 중 지도 표시 ${out.length}곳`);
  if (stats.unmatched.length) log(`좌표 못 찾음 ${stats.unmatched.length}곳:\n - ${stats.unmatched.join("\n - ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error("실패:", e.message); process.exit(1); });
}
