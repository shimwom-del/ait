# 이 집 얼마 들어? — 실거래 지도 연결

지도에서 아파트 가격 핀을 누르면 입주까지 드는 총비용을 계산하는 앱인토스 미니앱 프로토타입입니다.
데이터는 모두 공공 데이터입니다.

| 역할 | 출처 |
|---|---|
| 실거래가 | 국토교통부_아파트 매매 실거래가 상세 자료 (공공데이터포털 API) |
| 전국 시군구 코드 | 행정표준코드관리시스템 법정동코드 전체자료 |
| 단지 좌표 | 행정안전부 도로명주소 위치정보 요약DB (juso.go.kr 신청, 공공누리 1유형) — **준비 중** |
| 지도 배경 | V-World WMTS (앱에서만 사용) |

## 구조

```
GitHub Actions (매일 04:17 · 수동 실행 · main 의 앱/파이프라인 변경 시)
  ├─ actions/cache 로 pipeline/cache (월별 원본) 복원
  ├─ pipeline/build-data.mjs
  │    ├─ regions.json 의 전국 256개 시군구 × 12개월
  │    │    매일: 최근 3개월만 다시 받음 · 매달 1일: 12개월 전체 · 없는 달: 받음(백필)
  │    │    하루 9,000회에서 멈추고 다음 실행에서 이어 받음
  │    ├─ 해제거래 제외 → 단지·전용면적별 평균/건수/마지막 거래 집계
  │    ├─ 단지 좌표는 pipeline/apt-points.json 에서 붙임 (없으면 지도에서 빠짐)
  │    └─ data/index.json + data/complexes/{시군구코드}.json
  ├─ actions/cache 로 원본 저장 (실패해도 저장)
  └─ app/ + data/ 를 actions/deploy-pages 로 Pages 에 배포 (저장소에 커밋하지 않음)
앱 (app/index.html)
  ├─ 시작할 때 data/index.json 만 받음 → 서울 전체가 보이게 시작
  ├─ 시군구 10곳 이상 보이면 시군구별 "N곳" 원, 가까이 가면 보이는 시군구 파일만 받아 가격 핀
  └─ 검색: 시군구 이름 + 이미 불러온 단지 이름
```

인증키(`DATA_GO_KR_KEY`)는 GitHub Secrets 와 내 컴퓨터의 `.env` 에만 둬요. `.env`, `pipeline/cache/`, `data/` 는 `.gitignore` 로 커밋되지 않아요.
V-World 지도 키는 브라우저에서 쓰는 키라 앱 `CONFIG` 에 들어가고, 대신 V-World에 도메인을 등록해 다른 곳에서 못 쓰게 막아요.

## 처음 설정 (한 번만)

1. **공공데이터포털 인증키**: 「국토교통부_아파트 매매 실거래가 상세 자료」 활용 신청(자동 승인) → **일반 인증키(Decoding)**
   - 개발계정 하루 10,000회. 백필 약 3,200회, 매일 약 800회, 매달 1일 약 3,200회라 개발계정으로 충분해요.
2. **GitHub**
   - Settings → Secrets and variables → Actions → `DATA_GO_KR_KEY`
   - Settings → Pages → Source: **GitHub Actions**
   - Actions → 「실거래 데이터 갱신」 → Run workflow (첫 실행은 전국 백필이라 10~20분)
3. **앱 설정** — `app/index.html` 위쪽 `CONFIG`
   ```js
   const CONFIG = {
     DATA_BASE: "https://<아이디>.github.io/<저장소>/data/",
     VWORLD_KEY: "V-World 인증키"   // 비우면 개발용 OpenStreetMap
   };
   ```
   `DATA_BASE` 를 비우면 샘플 데이터로 돌아가요.

## 내 컴퓨터에서 실행

```
node pipeline/build-data.mjs                 # .env 의 DATA_GO_KR_KEY 사용
node pipeline/build-data.mjs --max-calls 500 # 이번 실행 호출 상한
node pipeline/build-data.mjs --full          # 12개월 전체 다시 받기
```
실행이 끝나면 호출 수·캐시 사용·남은 백필·좌표 매칭률을 출력하고 `pipeline/cache/runs.jsonl` 에 한 줄씩 남겨요.

## 시군구 목록 갱신

행정구역이 바뀌면(예: 2026년 인천·화성·전남광주 개편) 다시 만들고 커밋하세요.
```
node pipeline/build-regions.mjs
```
폐지 코드는 빼고, 구가 있는 시는 구 코드를 써요. 실거래 API는 바뀌기 전 달도 새 코드로 돌려줘요.

## 테스트

```
node pipeline/test/run-mock-test.mjs
```
가짜 API 서버로 백필 중단·이어 받기, 다음 날 최근 3개월, 1일 전체 갱신, 한도 초과, 인증키 오류, 페이지 나눔, 해제거래 제외, 시군구 파일·index, 좌표 매칭 실패를 확인해요. Actions 에서도 배포 전에 실행돼요.

## 확인 필요

- **단지 좌표**: 위치정보 요약DB 신청·심사 후 `pipeline/build-points.mjs` 로 `apt-points.json` 을 만들 예정이에요. 심사 때 가공 결과의 재배포 가능 여부도 확인해요. 그전까지는 지도에 단지가 표시되지 않아요.
- 앱인토스 WebView에서 V-World 타일 도메인(api.vworld.kr) 접근 허용 여부
- 관리비·공급면적은 실거래 API에 없어서 면적 비례 추정치를 써요
