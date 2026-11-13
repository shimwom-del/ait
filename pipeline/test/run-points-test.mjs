// build-points.mjs · utmk.mjs 검사 (네트워크 없음, 가짜 위치정보요약DB·캐시 사용)
// 실행: node pipeline/test/run-points-test.mjs

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { buildPoints, tradeRoadKey } from "../build-points.mjs";
import { utmkToWgs84, wgs84ToUtmk } from "../utmk.mjs";

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✔ ${name}`); } catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.message}`); }
};

// 1) 좌표 변환: 서울시청 주출입구(위치정보요약DB 실제 값)와 왕복 정확도
const cityHall = utmkToWgs84(953875.044172, 1951999.498732);
check("서울시청 UTM-K → WGS84", () => {
  assert.ok(Math.abs(cityHall.lat - 37.5662) < 0.001, `lat ${cityHall.lat}`);
  assert.ok(Math.abs(cityHall.lng - 126.9778) < 0.001, `lng ${cityHall.lng}`);
});
check("왕복 오차 1e-6도 미만 (제주~독도)", () => {
  for (const [la, lo] of [[33.2, 126.3], [37.5, 127.0], [38.6, 128.4], [35.1, 129.1], [37.24, 131.86]]) {
    const p = wgs84ToUtmk(la, lo), q = utmkToWgs84(p.x, p.y);
    assert.ok(Math.abs(q.lat - la) < 1e-6 && Math.abs(q.lng - lo) < 1e-6, `${la},${lo}`);
  }
});

// 2) 실거래 → 도로명 키
check("도로명 키: 지하여부 공백은 0, 본번·부번 앞자리 0 제거", () => {
  assert.equal(tradeRoadKey({ roadNmSggCd: 36110, roadNmCd: 3351281, roadNmbCd: " ", roadNmBonbun: "00180", roadNmBubun: "00000" }), "361103351281-0-180-0");
  assert.equal(tradeRoadKey({ roadNmSggCd: "11140", roadNmCd: "2005001", roadNmbCd: 1, roadNmBonbun: "00012", roadNmBubun: "00003" }), "111402005001-1-12-3");
  assert.equal(tradeRoadKey({ roadNmSggCd: " ", roadNmCd: " ", roadNmBonbun: " " }), null);
});

// 3) 전체 흐름: 도로명 매칭 · 이름 보완 · 실패 · 최근 거래 우선
const dir = await mkdtemp(join(tmpdir(), "points-test-"));
try {
  const geo = join(dir, "geo"), cache = join(dir, "cache"), out = join(dir, "apt-points.json");
  await mkdir(geo); await mkdir(join(cache, "41360"), { recursive: true });
  const row = (bjd, road, under, bon, bu, name, x, y) =>
    [bjd.slice(0, 5), "1", bjd, "SIDO", "SGG", "DONG", road, "ROAD", under, bon, bu, name, "00000", "HOUSE", "1", "DONG", x, y].join("|");
  await writeFile(join(geo, "entrc_test.txt"), [
    row("4136010100", "413603000001", "0", "10", "0", "ALPHA", "1000000.0", "2000000.0"),        // A: 도로명 일치
    row("4136010100", "413603000002", "0", "20", "0", "BETA 101", "1001000.0", "2001000.0"),     // B: 이름 보완 (두 동 평균)
    row("4136010100", "413603000002", "0", "22", "0", "BETA 102", "1003000.0", "2003000.0"),
    row("4136010100", "413603000009", "0", "99", "0", "GAMMA", "", ""),                          // 좌표 없음
    row("4136010100", "413603000005", "0", "50", "0", "NEW", "1005000.0", "2005000.0")           // D: 최근 달 주소
  ].join("\r\n") + "\r\n");
  const t = (o) => ({ sggCd: "41360", umdCd: "10100", umdNm: "DONG", jibun: "1", ...o });
  await writeFile(join(cache, "41360", "202608.json"), JSON.stringify({ lawdCd: "41360", ym: "202608", items: [
    t({ aptSeq: "41360-4", aptNm: "DELTA", roadNmSggCd: "41360", roadNmCd: "3000004", roadNmbCd: "0", roadNmBonbun: "00040", roadNmBubun: "00000" })
  ] }));
  await writeFile(join(cache, "41360", "202609.json"), JSON.stringify({ lawdCd: "41360", ym: "202609", items: [
    t({ aptSeq: "41360-1", aptNm: "ALPHA", roadNmSggCd: 41360, roadNmCd: 3000001, roadNmbCd: " ", roadNmBonbun: "00010", roadNmBubun: "00000" }),
    t({ aptSeq: "41360-2", aptNm: "BETA(B)", roadNmSggCd: " ", roadNmCd: " ", roadNmbCd: " ", roadNmBonbun: " ", roadNmBubun: " " }),
    t({ aptSeq: "41360-3", aptNm: "GAMMA", roadNmSggCd: "41360", roadNmCd: "3000009", roadNmbCd: "0", roadNmBonbun: "00099", roadNmBubun: "00000" }),
    t({ aptSeq: "41360-4", aptNm: "DELTA", roadNmSggCd: "41360", roadNmCd: "3000005", roadNmbCd: "0", roadNmBonbun: "00050", roadNmBubun: "00000" })
  ] }));

  const res = await buildPoints({ geoDir: geo, cacheDir: cache, outPath: out, log: () => {} });
  const json = JSON.parse(await readFile(out, "utf8"));
  const near = (p, x, y) => { const q = utmkToWgs84(x, y); return Math.abs(p[0] - q.lat) < 1e-6 && Math.abs(p[1] - q.lng) < 1e-6; };

  check("도로명주소로 매칭", () => assert.ok(near(json.points["41360-1"], 1000000, 2000000)));
  check("도로명주소 없으면 같은 법정동 건물명으로 보완 (평균)", () => assert.ok(near(json.points["41360-2"], 1002000, 2002000)));
  check("좌표 없는 건물은 실패로 셈", () => { assert.equal(json.points["41360-3"], undefined); assert.equal(res.stat.none, 1); });
  check("같은 단지는 가장 최근 달의 주소 사용", () => assert.ok(near(json.points["41360-4"], 1005000, 2005000)));
  check("points.mjs 형식 (source·points)", () => { assert.ok(json.source); assert.equal(res.size, 3); });
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failed) { console.log(`\n❌ ${failed}개 실패`); process.exit(1); }
console.log("\n✅ 좌표 검사 통과");
