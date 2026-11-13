// 전국 시군구(실거래 API LAWD_CD 5자리) 목록 만들기 → pipeline/regions.json
//
// 출처: 행정표준코드관리시스템(code.go.kr) '법정동코드 전체자료'
//   zip 안에 CP949 텍스트 1개: 법정동코드(10자리) \t 법정동명 \t 폐지여부(존재|폐지)
//
// 남기는 기준
//   - 끝 5자리가 00000 인 시군구 단위 (시도 단위 xx00000000 제외)
//   - 폐지여부 '존재'만 (실거래 API는 행정구역이 바뀌기 전 달도 새 코드로 돌려줌, 폐지 코드는 0건)
//   - 구가 있는 시(수원시 등)의 상위 코드는 제외하고 구 코드를 씀. 판단은 이름으로
//     (코드 앞자리로 보면 영동군 43740 / 증평군 43745 처럼 잘못 묶임)
//
// 실행: node pipeline/build-regions.mjs              (code.go.kr 에서 받음)
//       node pipeline/build-regions.mjs --file x.zip (받아둔 파일 사용)
// 행정구역이 바뀔 때만 다시 돌리고 regions.json 을 커밋하면 됨 (매일 실행 안 함)

import { readFile, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(ROOT, "pipeline", "regions.json");
const SOURCE_URL = "https://www.code.go.kr/etc/codeFullDown.do";
const SOURCE_NAME = "행정표준코드관리시스템 법정동코드 전체자료";

const SIDO_SHORT = {
  "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천",
  "광주광역시": "광주", "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종",
  "경기도": "경기", "강원특별자치도": "강원", "강원도": "강원",
  "충청북도": "충북", "충청남도": "충남", "전북특별자치도": "전북", "전라북도": "전북",
  "전라남도": "전남", "전남광주통합특별시": "전남광주",
  "경상북도": "경북", "경상남도": "경남", "제주특별자치도": "제주"
};
// 시도 아래에 시군구가 없는 곳 (시도 코드 자체가 LAWD_CD)
const SINGLE_TIER = new Set(["세종특별자치시"]);

// zip 첫 번째 파일 꺼내기 (중앙 디렉터리 기준, 외부 패키지 없이)
export function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip 형식이 아니에요");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("zip 중앙 디렉터리를 못 찾았어요");
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const localOff = buf.readUInt32LE(cd + 42);
  const dataOff = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
  const data = buf.subarray(dataOff, dataOff + compSize);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`지원하지 않는 zip 압축 방식: ${method}`);
}

export function parseRegions(text) {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).slice(1)
    .map((l) => l.split("\t").map((s) => s.trim()))
    .filter((r) => /^\d{10}$/.test(r[0]));
  if (rows.length < 10000) throw new Error(`행 수가 너무 적어요 (${rows.length}) — 파일 형식이 바뀌었는지 확인하세요`);

  const alive = rows.filter((r) => r[2] === "존재" && r[0].endsWith("00000") && !r[0].endsWith("00000000"));
  const singleTier = rows.filter((r) => r[2] === "존재" && r[0].endsWith("00000000") && SINGLE_TIER.has(r[1]));
  // 세종: 시도 행(3600000000)과 시군구 행(3611000000)이 둘 다 있으면 시군구 행을 씀
  const sgg = [...alive];
  for (const s of singleTier) if (!sgg.some((r) => r[1] === s[1])) sgg.push(s);

  const names = new Set(sgg.map((r) => r[1]));
  const isParent = (name) => [...names].some((n) => n !== name && n.startsWith(name + " "));

  const regions = [];
  for (const [code, fullName] of sgg) {
    if (isParent(fullName)) continue;
    const [sido, ...rest] = fullName.split(" ");
    if (!(sido in SIDO_SHORT)) throw new Error(`모르는 시도 이름: ${sido} — SIDO_SHORT 에 추가하세요`);
    regions.push({ lawdCd: code.slice(0, 5), sido, sigungu: rest.join(" ") });
  }

  // 화면용 짧은 이름: 광역시·특별시 → "서울 중구", 도 → "남양주"·"수원 장안구"·"양평군", 겹치면 시도를 붙임
  const metro = (sido) => /(특별시|광역시|통합특별시)$/.test(sido);
  const base = (r) => {
    if (!r.sigungu) return SIDO_SHORT[r.sido];
    if (metro(r.sido)) return `${SIDO_SHORT[r.sido]} ${r.sigungu}`;
    const [city, ...gu] = r.sigungu.split(" ");
    return [city.replace(/시$/, ""), ...gu].join(" ");
  };
  const count = new Map();
  for (const r of regions) count.set(base(r), (count.get(base(r)) || 0) + 1);
  for (const r of regions) r.label = count.get(base(r)) > 1 ? `${SIDO_SHORT[r.sido]} ${base(r)}` : base(r);

  const codes = new Set(regions.map((r) => r.lawdCd));
  if (codes.size !== regions.length) throw new Error("LAWD_CD 가 겹쳐요");
  const labels = new Set(regions.map((r) => r.label));
  if (labels.size !== regions.length) throw new Error("label 이 겹쳐요");
  return regions.sort((a, b) => a.lawdCd.localeCompare(b.lawdCd));
}

async function main() {
  const i = process.argv.indexOf("--file");
  let buf;
  if (i > 0) {
    buf = await readFile(process.argv[i + 1]);
  } else {
    const res = await fetch(SOURCE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "codeseId=" + encodeURIComponent("법정동코드")
    });
    if (!res.ok) throw new Error(`code.go.kr 응답 ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  // zip 안 파일의 수정일 = 자료 기준일
  const cd = buf.readUInt32LE(buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 16);
  const dosDate = buf.readUInt16LE(cd + 14);
  const sourceDate = `${(dosDate >> 9) + 1980}-${String((dosDate >> 5) & 15).padStart(2, "0")}-${String(dosDate & 31).padStart(2, "0")}`;

  const text = new TextDecoder("euc-kr").decode(unzipFirst(buf));
  const regions = parseRegions(text);
  if (regions.length < 200) throw new Error(`시군구가 ${regions.length}곳뿐이에요 — 파일을 확인하세요`);

  await writeFile(OUT_PATH, JSON.stringify({
    source: SOURCE_NAME,
    sourceUrl: "https://www.code.go.kr",
    sourceDate,
    generatedAt: new Date().toISOString(),
    count: regions.length,
    regions
  }, null, 1) + "\n");

  const bySido = new Map();
  for (const r of regions) bySido.set(r.sido, (bySido.get(r.sido) || 0) + 1);
  console.log(`regions.json: ${regions.length}곳 (자료 기준일 ${sourceDate})`);
  console.log([...bySido].map(([s, n]) => `${SIDO_SHORT[s]} ${n}`).join(" · "));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error("실패:", e.message); process.exit(1); });
}
