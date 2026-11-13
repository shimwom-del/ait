// 가짜 공공 API 서버를 띄워 build-data.mjs 를 여러 번 돌려보는 테스트
// 실행: node pipeline/test/run-mock-test.mjs
//
// 시나리오 (날짜는 NOW 로 고정, 한국 시간 기준)
//   A  11/13  --max-calls 10  → 백필 도중 멈춤, 12개월이 덜 모여 결과 비어 있음
//   B  11/13  이어 받기        → 빠진 달만 받음, 같은 날 받은 최근 달은 다시 안 받음
//   C  11/14  다음 날          → 최근 3개월만 다시 받음
//   D  12/01  1일              → 12개월 전체 다시 받음 + 범위 밖(2025-12) 캐시 삭제
//   E  12/02  API 한도 초과(22) → 멈추고 캐시로 결과를 만듦
//   F  12/03  인증키 오류       → 재시도 없이 실패, 캐시 유지
//   G  12/04  시군구 목록 변경   → 빠진 시군구 결과 파일 삭제
// 결과: data/index.json + data/complexes/{LAWD_CD}.json, 좌표는 pipeline/apt-points.json (가짜)
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAY = { A: "2026-11-13T03:00:00Z", B: "2026-11-13T05:00:00Z", C: "2026-11-14T03:00:00Z", D: "2026-11-30T16:00:00Z" /* = 12/01 01시 KST */, E: "2026-12-02T03:00:00Z" };
const ym = "202611"; // 거래가 있는 달
const Y = "2026", M = "11";

const t = (o) => ({ dealYear: Y, dealMonth: M, cdealType: " ", ...o });
// 3건(1건 해제) — 페이지 2개로 나눠 응답 (1페이지: 앞 2건, 2페이지: 마지막 1건)
// 2페이지에는 유효 거래를 둬야 페이지 나눔이 고장 났을 때 건수·마지막 거래 검사가 실패함
const GURI = [
  t({ aptSeq: "41310-1", aptNm: "갈매테스트단지", umdNm: "갈매동", jibun: "665", excluUseAr: "84.97", dealAmount: " 79,250", dealDay: "14", floor: "15", buildYear: "2016" }),
  t({ aptSeq: "41310-1", aptNm: "갈매테스트단지", umdNm: "갈매동", jibun: "665", excluUseAr: "84.97", dealAmount: "95,000", dealDay: "21", floor: "9", buildYear: "2016", cdealType: "O" }),
  t({ aptSeq: "41310-1", aptNm: "갈매테스트단지", umdNm: "갈매동", jibun: "665", excluUseAr: "84.91", dealAmount: "81,000", dealDay: "20", floor: "3", buildYear: "2016" })
];
const NAMYANGJU = t({ aptSeq: "41360-9", aptNm: "좌표없는단지", umdNm: "다산동", jibun: "9999", excluUseAr: "59.9", dealAmount: "60,000", dealDay: "02", floor: "7", buildYear: "2020" });

let quotaExceeded = false, badKey = false;
const requests = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (u.pathname === "/rtms") {
    assert.equal(u.searchParams.get("serviceKey"), "test+key/=", "인증키 인코딩");
    const lawd = u.searchParams.get("LAWD_CD"), ymd = u.searchParams.get("DEAL_YMD"), page = +u.searchParams.get("pageNo");
    requests.push(`${lawd}/${ymd}/p${page}`);
    if (badKey) { res.setHeader("content-type", "text/xml"); return res.end("<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>"); }
    if (quotaExceeded) return res.end(JSON.stringify({ response: { header: { resultCode: "22", resultMsg: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR" } } }));
    let items = "", total = 0;
    if (ymd === ym && lawd === "41310") { total = 3; items = { item: page === 1 ? GURI.slice(0, 2) : GURI.slice(2) }; }
    if (ymd === ym && lawd === "41360") { total = 1; items = { item: NAMYANGJU }; } // 단일 객체 응답
    return res.end(JSON.stringify({ response: { header: { resultCode: "000", resultMsg: "OK" }, body: { items, totalCount: total, pageNo: page } } }));
  }
  res.statusCode = 404; res.end("{}"); // V-World 등 다른 곳은 부르면 안 됨
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// 임시 폴더에 스크립트만 복사해서 실행 (원본 data/·cache 를 건드리지 않음)
const work = await mkdtemp(join(tmpdir(), "hc-"));
await mkdir(join(work, "pipeline"), { recursive: true });
for (const f of ["build-data.mjs", "points.mjs", "config.json"]) await cp(join(ROOT, "pipeline", f), join(work, "pipeline", f));
// 단지 좌표 (3단계 build-points.mjs 결과 형식). 남양주 '좌표없는단지'(41360-9)는 일부러 없음
await writeFile(join(work, "pipeline", "apt-points.json"), JSON.stringify({ source: "테스트 좌표", points: { "41310-1": [37.6385, 127.1235] } }));
const regionsPath = join(work, "regions.json");
await writeFile(regionsPath, JSON.stringify({ regions: [
  { lawdCd: "41310", sido: "경기도", sigungu: "구리시", label: "구리" },
  { lawdCd: "41360", sido: "경기도", sigungu: "남양주시", label: "남양주" }
] }));
const cacheDir = join(work, "pipeline", "cache");

async function run(name, now, args = [], expectCode = 0) {
  const before = requests.length;
  const code = await new Promise((r) => {
    const p = spawn(process.execPath, [join(work, "pipeline", "build-data.mjs"), ...args], {
      env: { ...process.env, DATA_GO_KR_KEY: "test+key/=", VWORLD_KEY: "", RTMS_URL: `http://127.0.0.1:${port}/rtms`,
        REGIONS_PATH: regionsPath, NOW: now, CONCURRENCY: "1", REQUEST_GAP_MS: "0" },
      stdio: ["ignore", "pipe", "inherit"]
    });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    p.on("exit", (c) => { console.log(`\n── ${name} (${now}) ──\n${out.trim()}`); r(c); });
  });
  assert.equal(code, expectCode, `${name}: 종료 코드`);
  if (expectCode !== 0) return { reqs: requests.slice(before) };
  const logLines = (await readFile(join(cacheDir, "runs.jsonl"), "utf8")).trim().split("\n");
  const summary = JSON.parse(logLines.at(-1));
  const index = JSON.parse(await readFile(join(work, "data", "index.json"), "utf8"));
  const regionFile = async (lawd) => { try { return JSON.parse(await readFile(join(work, "data", "complexes", `${lawd}.json`), "utf8")); } catch { return null; } };
  const guri = await regionFile("41310"), nyj = await regionFile("41360");
  const out = {
    index, guri, nyj, period: index.period,
    complexes: [...(guri?.complexes || []), ...(nyj?.complexes || [])],
    pendingRegions: index.regions.filter((x) => x.status === "pending").map((x) => x.label)
  };
  return { summary, out, reqs: requests.slice(before) };
}
const regionOf = (out, lawd) => out.index.regions.find((x) => x.lawdCd === lawd);
const cacheFiles = async (lawd) => (await readdir(join(cacheDir, lawd))).filter((f) => /^\d{6}\.json$/.test(f)).sort();

// A: 백필 도중 멈춤
let r = await run("A 백필 시작 (--max-calls 10)", DAY.A, ["--max-calls", "10"]);
assert.equal(r.reqs.length, 10, "A: 상한만큼만 호출");
assert.equal(r.summary.calls, 10);
assert.ok(r.summary.stoppedEarly, "A: 멈춤 기록");
assert.equal(r.reqs[0], "41310/202611/p1", "A: 최근 달부터");
assert.equal(r.reqs[1], "41310/202611/p2", "A: 2페이지까지 받음");
assert.equal((await cacheFiles("41310")).length + (await cacheFiles("41360")).length, 9, "A: 받은 달 9개 저장 (구리 11월은 2쪽)");
assert.equal(r.summary.backfillRemaining, 15, "A: 남은 백필 15개월");
assert.equal(r.out.complexes.length, 0, "A: 12개월이 덜 모이면 결과에 안 넣음");
assert.deepEqual(r.out.pendingRegions, ["구리", "남양주"]);
assert.equal(r.out.guri, null, "A: pending 시군구는 파일 없음");
assert.deepEqual(regionOf(r.out, "41310"), { lawdCd: "41310", sido: "경기도", sigungu: "구리시", label: "구리", center: null, bbox: null, complexes: 0, mapped: 0, trades: 0, updatedAt: null, status: "pending" });
assert.ok(!existsSync(join(work, "data", "complexes.json")), "예전 단일 파일 없음");

// B: 같은 날 이어 받기
r = await run("B 이어 받기 (같은 날)", DAY.B);
assert.equal(r.reqs.length, 15, "B: 빠진 15개월만 호출");
assert.ok(!r.reqs.some((q) => q.includes("/202611/") || q.includes("/202610/") || q.includes("/202609/")), "B: 오늘 받은 최근 달은 다시 안 받음");
assert.equal(r.summary.callsToday, 25, "B: 오늘 누적 호출");
assert.equal(r.summary.backfillRemaining, 0);
assert.equal(r.summary.regionsComplete, 2);
assert.equal(r.out.complexes.length, 1, "B: 좌표 있는 단지만 포함");
const c = r.out.complexes[0];
assert.equal(c.name, "갈매테스트단지");
assert.equal(c.lat, 37.6385);
assert.equal(c.address, "경기도 구리시 갈매동 665");
assert.equal(c.areas.length, 1, "84.97·84.91 → 84㎡ 한 타입");
const a = c.areas[0];
assert.equal(a.areaM2, 84);
assert.equal(a.txCount12m, 2, "해제거래 제외 + 2페이지 거래 포함");
assert.equal(a.avgPriceManwon, Math.round((79250 + 81000) / 2));
assert.equal(a.lastTxPriceManwon, 81000, "가장 최근 거래");
assert.equal(a.floorRange, "3층 ~ 15층");
assert.equal(a.lowTxRecords.length, 2, "3건 미만이면 개별 거래");
// 시군구 파일·index
assert.equal(r.out.guri.lawdCd, "41310");
assert.equal(r.out.guri.label, "구리");
assert.equal(r.out.guri.period.months, 12);
assert.equal(r.out.guri.updatedAt, "2026-11-13T05:00:00.000Z", "시군구 갱신일 = 가장 최근에 받은 캐시");
assert.deepEqual(r.out.nyj.complexes, [], "좌표 없는 단지는 파일에 안 넣음");
const g = regionOf(r.out, "41310"), n = regionOf(r.out, "41360");
assert.deepEqual([g.status, g.complexes, g.mapped, g.trades], ["ok", 1, 1, 2]);
assert.deepEqual(g.center, [37.6385, 127.1235], "중심 = 단지 좌표 평균");
assert.deepEqual(g.bbox, [37.6385, 127.1235, 37.6385, 127.1235]);
assert.deepEqual([n.status, n.complexes, n.mapped, n.center, n.bbox], ["ok", 1, 0, null, null], "좌표 없는 시군구는 중심 없음");
assert.equal(r.summary.unmatched, 1, "매칭 실패 1곳 기록");
assert.equal(r.out.index.source, "국토교통부 아파트 매매 실거래가 상세 자료 (공공데이터포털) · 좌표: 테스트 좌표");
assert.ok(!existsSync(join(work, "pipeline", "geo-cache.json")), "geo-cache.json 안 만듦");
const sampleOut = r.out.guri;

// C: 다음 날 — 최근 3개월만
r = await run("C 다음 날 (최근 3개월)", DAY.C);
assert.deepEqual(r.reqs.map((q) => q.split("/")[1]).filter((v, i, s) => s.indexOf(v) === i).sort(), ["202609", "202610", "202611"], "C: 최근 3개월만");
assert.equal(r.reqs.length, 7, "C: 2곳 × 3개월 + 구리 11월 2쪽");
assert.equal(r.summary.mode, "daily");
assert.equal(r.summary.monthsFromCache, 18);
assert.equal(r.out.complexes[0].areas[0].txCount12m, 2);

// D: 1일 — 전체 갱신, 범위 밖 캐시 삭제
r = await run("D 1일 전체 갱신", DAY.D);
assert.equal(r.summary.mode, "full");
assert.equal(r.summary.monthsPruned, 2, "D: 2025-12 캐시 2개 삭제");
assert.ok(!existsSync(join(cacheDir, "41310", "202512.json")));
assert.equal(r.reqs.length, 25, "D: 2곳 × 12개월 + 구리 11월 2쪽");
assert.ok(r.reqs.includes("41310/202612/p1") && r.reqs.includes("41310/202601/p1"), "D: 새 범위 202601~202612");
assert.equal(r.out.period.from, "202601");
assert.equal(r.out.complexes[0].areas[0].txCount12m, 2, "D: 11월 거래 유지");

// E: API 한도 초과 — 멈추고 캐시로 결과
quotaExceeded = true;
r = await run("E API 한도 초과", DAY.E);
assert.equal(r.reqs.length, 1, "E: 22를 받으면 바로 멈춤");
assert.match(r.summary.stoppedEarly, /한도 초과/);
assert.equal(r.out.complexes.length, 1, "E: 캐시로 결과 유지");

// F: 인증키 오류 — 재시도 없이 실패로 끝남, 캐시는 그대로
quotaExceeded = false; badKey = true;
const before = (await cacheFiles("41310")).length;
r = await run("F 인증키 오류", "2026-12-03T03:00:00Z", [], 1);
assert.equal(r.reqs.length, 1, "F: 재시도 없이 바로 멈춤");
assert.equal((await cacheFiles("41310")).length, before, "F: 캐시 유지");

// G: 목록에서 빠진 시군구는 결과 파일도 지움
badKey = false; quotaExceeded = true;
await writeFile(regionsPath, JSON.stringify({ regions: [{ lawdCd: "41310", sido: "경기도", sigungu: "구리시", label: "구리" }] }));
r = await run("G 시군구 목록 변경", "2026-12-04T03:00:00Z");
assert.equal(r.out.index.regions.length, 1);
assert.equal(r.out.nyj, null, "G: 빠진 시군구 파일 삭제");
assert.equal(r.out.guri.complexes.length, 1);

server.close();
console.log("\n✅ 모든 검사 통과");
await writeFile(join(ROOT, "pipeline", "test", "sample-output.json"), JSON.stringify(sampleOut, null, 1));
