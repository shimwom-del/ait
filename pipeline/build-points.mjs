// 3단계: 단지 좌표 파일(pipeline/apt-points.json) 만들기 — 로컬에서 실행
//
// 실행: node pipeline/build-points.mjs [--geo geo-src] [--cache pipeline/cache] [--out pipeline/apt-points.json]
//
//   1) 실거래 원본 캐시(pipeline/cache/{LAWD_CD}/{YYYYMM}.json)에서 단지(aptSeq)별 도로명주소를 모음
//      (가장 최근 거래 기준. 도로명코드 = roadNmSggCd(5) + roadNmCd(7), 지하여부, 건물본번·부번)
//   2) 도로명주소 「위치정보요약DB」 전체분(geo-src/entrc_*.txt, CP949, '|' 구분, 좌표 UTM-K)에서
//      같은 도로명주소의 주출입구 좌표를 찾아 WGS84 로 바꿈
//   3) 도로명주소가 없거나 못 찾은 단지는 같은 법정동 안에서 건물명이 단지명으로 시작하는 건물들의 평균 좌표로 보완
//
// 결과 형식은 points.mjs 가 읽는 그대로: { source, generatedAt, basis, points: { "<aptSeq>": [lat, lng] } }
// 위치정보요약DB 원본(geo-src/)은 커밋하지 않음. 결과에는 실거래가 있는 단지 좌표만 들어감.

import { readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { utmkToWgs84 } from "./utmk.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = "행정안전부 도로명주소 위치정보요약DB";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : def;
};

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v) => parseInt(str(v), 10);

// 실거래 레코드 → 도로명 키 (위치정보요약DB 의 PK1~PK4 와 같은 모양)
export function tradeRoadKey(r) {
  const sgg = str(r.roadNmSggCd), cd = str(r.roadNmCd), bon = num(r.roadNmBonbun);
  if (!/^\d{5}$/.test(sgg) || !/^\d{1,7}$/.test(cd) || !(bon > 0)) return null;
  const under = str(r.roadNmbCd) || "0";
  return `${sgg}${cd.padStart(7, "0")}-${under}-${bon}-${num(r.roadNmBubun) || 0}`;
}

// 위치정보요약DB 한 줄의 필드 → 같은 모양의 키
const entrcRoadKey = (f) => `${f[6]}-${str(f[8]) || "0"}-${num(f[9])}-${num(f[10]) || 0}`;

// 이름 비교용: 공백·괄호 안 내용·'아파트' 제거
export const normName = (s) => str(s).replace(/\(.*?\)/g, "").replace(/아파트/g, "").replace(/\s+/g, "");

// build-data.mjs normalize() 와 같은 단지 키
const complexKey = (r, lawdCd) => str(r.aptSeq) || `${lawdCd}-${str(r.umdNm)}-${str(r.jibun)}-${str(r.aptNm)}`;

async function collectComplexes(cacheDir) {
  const complexes = new Map(); // key → { ym, roadKey, bjd, name, label }
  let files = 0;
  for (const lawdCd of (await readdir(cacheDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const fn of (await readdir(join(cacheDir, lawdCd))).filter((f) => /^\d{6}\.json$/.test(f))) {
      const c = JSON.parse(await readFile(join(cacheDir, lawdCd, fn), "utf8"));
      files++;
      for (const r of c.items || []) {
        const key = complexKey(r, lawdCd);
        const roadKey = tradeRoadKey(r);
        const prev = complexes.get(key);
        // 가장 최근 달 기준, 같은 달이면 도로명주소가 있는 쪽
        if (prev && (prev.ym > c.ym || (prev.ym === c.ym && (prev.roadKey || !roadKey)))) continue;
        const sgg = str(r.sggCd), umd = str(r.umdCd);
        complexes.set(key, {
          ym: c.ym,
          roadKey,
          bjd: /^\d{5}$/.test(sgg) && /^\d{5}$/.test(umd) ? sgg + umd : null,
          name: normName(r.aptNm),
          label: `${lawdCd} ${str(r.umdNm)} ${str(r.aptNm)}`
        });
      }
    }
  }
  return { complexes, files };
}

async function scanGeo(geoDir, wantRoad, wantBjd) {
  const byRoad = new Map(); // roadKey → {x, y}
  const byBjd = new Map();  // 법정동코드 → [{ name, x, y }]
  const decoder = new TextDecoder("euc-kr");
  const files = (await readdir(geoDir)).filter((f) => /^entrc_.*\.txt$/.test(f)).sort();
  if (!files.length) throw new Error(`${geoDir} 에 entrc_*.txt 가 없어요`);
  let lines = 0, noCoord = 0;
  for (const fn of files) {
    const text = decoder.decode(await readFile(join(geoDir, fn)));
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const f = line.split("|");
      if (f.length < 18) continue;
      lines++;
      const x = parseFloat(f[16]), y = parseFloat(f[17]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) { noCoord++; continue; }
      const rk = entrcRoadKey(f);
      if (wantRoad.has(rk) && !byRoad.has(rk)) byRoad.set(rk, { x, y });
      if (wantBjd.has(f[2])) {
        const name = normName(f[11]);
        if (name) {
          if (!byBjd.has(f[2])) byBjd.set(f[2], []);
          byBjd.get(f[2]).push({ name, x, y });
        }
      }
    }
  }
  return { byRoad, byBjd, files: files.length, lines, noCoord };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

export async function buildPoints({ geoDir, cacheDir, outPath, log = console.log }) {
  const { complexes, files } = await collectComplexes(cacheDir);
  log(`실거래 캐시 ${files}개 파일 · 단지 ${complexes.size}곳`);
  const wantRoad = new Set(), wantBjd = new Set();
  for (const c of complexes.values()) {
    if (c.roadKey) wantRoad.add(c.roadKey);
    if (c.bjd) wantBjd.add(c.bjd); // 법정동코드 10자리 = 시군구 5 + API umdCd 5 (DB 의 읍면동3 + "00" 과 같음)
  }
  const geo = await scanGeo(geoDir, wantRoad, wantBjd);
  log(`위치정보요약DB ${geo.files}개 파일 · ${geo.lines.toLocaleString()}줄 (좌표 없음 ${geo.noCoord.toLocaleString()})`);

  const points = {};
  const stat = { road: 0, name: 0, none: 0, noRoadKey: 0 };
  const unmatched = [];
  for (const [key, c] of complexes) {
    if (!c.roadKey) stat.noRoadKey++;
    let p = c.roadKey ? geo.byRoad.get(c.roadKey) : null;
    if (p) stat.road++;
    else if (c.bjd && c.name) {
      const hits = (geo.byBjd.get(c.bjd) || []).filter((e) => e.name.startsWith(c.name));
      if (hits.length) {
        p = { x: hits.reduce((s, e) => s + e.x, 0) / hits.length, y: hits.reduce((s, e) => s + e.y, 0) / hits.length };
        stat.name++;
      }
    }
    if (!p) { stat.none++; unmatched.push(c.label); continue; }
    const { lat, lng } = utmkToWgs84(p.x, p.y);
    points[key] = [round6(lat), round6(lng)];
  }

  const sorted = Object.fromEntries(Object.keys(points).sort().map((k) => [k, points[k]]));
  const out = {
    source: SOURCE,
    generatedAt: new Date().toISOString(),
    basis: "도로명주소 주출입구 좌표 (UTM-K → WGS84)",
    points: sorted
  };
  const tmp = outPath + ".tmp";
  await writeFile(tmp, JSON.stringify(out) + "\n");
  await rename(tmp, outPath);

  const pct = (n) => (complexes.size ? ((n / complexes.size) * 100).toFixed(1) : "0");
  log(`좌표: 도로명주소 ${stat.road}곳 (${pct(stat.road)}%) · 이름 보완 ${stat.name}곳 · 실패 ${stat.none}곳 (${pct(stat.none)}%) · 도로명주소 없는 거래 단지 ${stat.noRoadKey}곳`);
  if (unmatched.length) log(`실패 예: ${unmatched.slice(0, 10).join(" / ")}`);
  log(`저장: ${outPath} (${Object.keys(sorted).length}곳)`);
  return { stat, unmatched, size: Object.keys(sorted).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildPoints({
    geoDir: arg("--geo", join(ROOT, "geo-src")),
    cacheDir: arg("--cache", process.env.CACHE_DIR || join(ROOT, "pipeline", "cache")),
    outPath: arg("--out", process.env.POINTS_PATH || join(ROOT, "pipeline", "apt-points.json"))
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
