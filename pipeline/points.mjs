// 단지 좌표 공급
//
// pipeline/apt-points.json (3단계 build-points.mjs 가 만듦) 을 읽어 단지 id(aptSeq) → [위도, 경도] 를 돌려줌.
//   형식: { "source": "...", "generatedAt": "...", "points": { "<aptSeq>": [lat, lng], ... } }
// 파일이 없으면 빈 목록 → 모든 단지가 '좌표 없음'으로 처리됨 (V-World 지오코더는 쓰지 않음)

import { readFile } from "node:fs/promises";

export async function loadPoints(path) {
  let json;
  try { json = JSON.parse(await readFile(path, "utf8")); } catch { return { source: null, get: () => null, size: 0 }; }
  const pts = json.points || {};
  return {
    source: json.source || null,
    size: Object.keys(pts).length,
    get(id) {
      const p = pts[id];
      return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { lat: p[0], lng: p[1] } : null;
    }
  };
}
