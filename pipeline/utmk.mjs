// UTM-K (GRS80, EPSG:5179) ↔ WGS84 위경도
//
// 위치정보요약DB 좌표가 UTM-K 라서 지도(Leaflet, WGS84)용으로 바꿈. 외부 패키지 없이 횡메르카토르 공식 사용.
// GRS80 과 WGS84 타원체 차이는 지도 핀 용도에서 무시할 수준(1mm 미만)이라 따로 보정하지 않음.

const A = 6378137;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const LAT0 = (38 * Math.PI) / 180;
const LON0 = (127.5 * Math.PI) / 180;
const FE = 1000000;
const FN = 2000000;

const E2 = F * (2 - F);
const E4 = E2 * E2;
const E6 = E4 * E2;
const EP2 = E2 / (1 - E2);
const M1 = 1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256;

// 적도에서 위도 phi 까지의 자오선 호 길이
function meridian(phi) {
  return A * (
    M1 * phi
    - ((3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024) * Math.sin(2 * phi)
    + ((15 * E4) / 256 + (45 * E6) / 1024) * Math.sin(4 * phi)
    - ((35 * E6) / 3072) * Math.sin(6 * phi)
  );
}
const MER0 = meridian(LAT0);

export function utmkToWgs84(x, y) {
  const mu = (MER0 + (y - FN) / K0) / (A * M1);
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin1 = Math.sin(phi1), cos1 = Math.cos(phi1), tan1 = Math.tan(phi1);
  const c1 = EP2 * cos1 * cos1;
  const t1 = tan1 * tan1;
  const w = 1 - E2 * sin1 * sin1;
  const n1 = A / Math.sqrt(w);
  const r1 = (A * (1 - E2)) / (w * Math.sqrt(w));
  const d = (x - FE) / (n1 * K0);
  const lat = phi1 - ((n1 * tan1) / r1) * (
    (d ** 2) / 2
    - ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24
    + ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) * d ** 6) / 720
  );
  const lon = LON0 + (
    d
    - ((1 + 2 * t1 + c1) * d ** 3) / 6
    + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) / 120
  ) / cos1;
  return { lat: (lat * 180) / Math.PI, lng: (lon * 180) / Math.PI };
}

// 시험용 정방향 변환 (위경도 → UTM-K)
export function wgs84ToUtmk(latDeg, lngDeg) {
  const phi = (latDeg * Math.PI) / 180, lam = (lngDeg * Math.PI) / 180;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const n = A / Math.sqrt(1 - E2 * s * s);
  const tt = t * t, cc = EP2 * c * c, a = (lam - LON0) * c;
  const x = FE + K0 * n * (a + ((1 - tt + cc) * a ** 3) / 6 + ((5 - 18 * tt + tt ** 2 + 72 * cc - 58 * EP2) * a ** 5) / 120);
  const y = FN + K0 * (meridian(phi) - MER0 + n * t * ((a ** 2) / 2 + ((5 - tt + 9 * cc + 4 * cc ** 2) * a ** 4) / 24
    + ((61 - 58 * tt + tt ** 2 + 600 * cc - 330 * EP2) * a ** 6) / 720));
  return { x, y };
}
