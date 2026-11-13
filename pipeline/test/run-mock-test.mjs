// 가짜 공공 API 서버를 띄워 build-data.mjs 를 끝까지 돌려보는 테스트
// 실행: node pipeline/test/run-mock-test.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const now = new Date(Date.now() + 9 * 3600e3);
const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const Y = ym.slice(0, 4), M = String(+ym.slice(4));

const t = (o) => ({ dealYear: Y, dealMonth: M, cdealType: " ", ...o });
// 3건(1건 해제) — 페이지 2개로 나눠 응답 (1페이지: 앞 2건, 2페이지: 마지막 1건)
// 2페이지에는 유효 거래를 둬야 페이지 나눔이 고장 났을 때 건수·마지막 거래 검사가 실패함
const GURI = [
  t({ aptSeq: "41310-1", aptNm: "갈매테스트단지", umdNm: "갈매동", jibun: "665", excluUseAr: "84.97", dealAmount: " 79,250", dealDay: "14", floor: "15", buildYear: "2016" }),
  t({ aptSeq: "41310-1", aptNm: "갈매테스트단지", umdNm: "갈매동", jibun: "665", excluUseAr: "84.97", dealAmount: "95,000", dealDay: "21", floor: "9", buildYear: "2016", cdealType: "O" }),
  t({ aptSeq: "41310-1", aptNm: "갈매테스트단지", umdNm: "갈매동", jibun: "665", excluUseAr: "84.91", dealAmount: "81,000", dealDay: "20", floor: "3", buildYear: "2016" })
];
const NAMYANGJU = t({ aptSeq: "41360-9", aptNm: "좌표없는단지", umdNm: "다산동", jibun: "9999", excluUseAr: "59.9", dealAmount: "60,000", dealDay: "02", floor: "7", buildYear: "2020" });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("content-type", "application/json");
  if (u.pathname === "/rtms") {
    assert.equal(u.searchParams.get("serviceKey"), "test+key/=", "인증키 인코딩");
    const lawd = u.searchParams.get("LAWD_CD"), ymd = u.searchParams.get("DEAL_YMD"), page = +u.searchParams.get("pageNo");
    let items = "", total = 0;
    if (ymd === ym && lawd === "41310") { total = 3; items = { item: page === 1 ? GURI.slice(0, 2) : GURI.slice(2) }; }
    if (ymd === ym && lawd === "41360") { total = 1; items = { item: NAMYANGJU }; } // 단일 객체 응답
    return res.end(JSON.stringify({ response: { header: { resultCode: "000", resultMsg: "OK" }, body: { items, totalCount: total, pageNo: page } } }));
  }
  if (u.pathname === "/vworld") {
    const addr = u.searchParams.get("address");
    if (addr.includes("갈매동 665")) return res.end(JSON.stringify({ response: { status: "OK", result: { point: { x: "127.1235", y: "37.6385" } } } }));
    return res.end(JSON.stringify({ response: { status: "NOT_FOUND" } }));
  }
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// 저장소 복사본에서 실행 (원본 data/·geo-cache 를 건드리지 않음)
const work = await mkdtemp(join(tmpdir(), "hc-"));
await cp(join(ROOT, "pipeline"), join(work, "pipeline"), { recursive: true });
await writeFile(join(work, "pipeline", "geo-cache.json"), "{}");

const code = await new Promise((r) => {
  const p = spawn(process.execPath, [join(work, "pipeline", "build-data.mjs")], {
    env: { ...process.env, DATA_GO_KR_KEY: "test+key/=", VWORLD_KEY: "vk", RTMS_URL: `http://127.0.0.1:${port}/rtms`, VWORLD_URL: `http://127.0.0.1:${port}/vworld` },
    stdio: "inherit"
  });
  p.on("exit", r);
});
server.close();
assert.equal(code, 0, "스크립트 종료 코드");

const out = JSON.parse(await readFile(join(work, "data", "complexes.json"), "utf8"));
assert.equal(out.complexes.length, 1, "좌표 있는 단지만 포함");
const c = out.complexes[0];
assert.equal(c.name, "갈매테스트단지");
assert.equal(c.lat, 37.6385);
assert.equal(c.areas.length, 1, "84.97·84.91 → 84㎡ 한 타입");
const a = c.areas[0];
assert.equal(a.areaM2, 84);
assert.equal(a.txCount12m, 2, "해제거래 제외 + 2페이지 거래 포함");
assert.equal(a.avgPriceManwon, Math.round((79250 + 81000) / 2));
assert.equal(a.lastTxPriceManwon, 81000, "가장 최근 거래");
assert.equal(a.floorRange, "3층 ~ 15층");
assert.equal(a.lowTxRecords.length, 2, "3건 미만이면 개별 거래");
const cache = JSON.parse(await readFile(join(work, "pipeline", "geo-cache.json"), "utf8"));
assert.ok(cache["41360-9"].failedAt, "좌표 실패도 캐시에 기록");
console.log("\n✅ 모든 검사 통과");
await writeFile(join(ROOT, "pipeline", "test", "sample-output.json"), JSON.stringify(out, null, 1));
