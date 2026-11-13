# 이 집 얼마 들어? — 실거래 지도 연결

지도에서 아파트 가격 핀을 누르면 입주까지 드는 총비용을 계산하는 앱인토스 미니앱 프로토타입입니다.
데이터는 모두 공공 API입니다.

| 역할 | API (공공데이터포털에서 신청) |
|---|---|
| 실거래가 | 국토교통부_아파트 매매 실거래가 상세 자료 |
| 주소 → 좌표 | 국토교통부_지오코더 API (V-World) |
| 지도 배경 | 국토교통부_WMTS (V-World 배경지도) |

## 구조

```
GitHub Actions (매일 04:17)
  └─ pipeline/build-data.mjs
       ├─ 실거래 API: 지역 3곳 × 12개월 호출
       ├─ 해제거래 제외 → 단지·전용면적별 평균/건수/마지막 거래 집계
       ├─ V-World 지오코더로 단지 좌표 (pipeline/geo-cache.json 에 저장, 다음부터 재사용)
       └─ data/complexes.json 저장 → 커밋
앱 (app/index.html)
  └─ complexes.json 하나만 읽어서 지도 핀 + 계산
```

인증키는 GitHub Secrets에만 두고 앱에는 넣지 않아요. 내 컴퓨터에서 파이프라인을 돌릴 때는 저장소 루트의 `.env`(`DATA_GO_KR_KEY=...`, `VWORLD_KEY=...`)에서 읽고, `.env`는 `.gitignore`로 커밋되지 않아요. 단, V-World 지도 키는 브라우저에서 쓰는 키라 앱에 들어가고, 대신 V-World에 도메인을 등록해 다른 곳에서 못 쓰게 막아요.

## 처음 설정 (한 번만)

1. **공공데이터포털 인증키**
   - data.go.kr에서 「국토교통부_아파트 매매 실거래가 상세 자료」 활용 신청 (자동 승인)
   - 마이페이지에서 **일반 인증키 (Decoding)** 복사
2. **V-World 인증키**
   - vworld.kr 회원가입 → 오픈API → 인증키 발급
   - 서비스 URL에 앱 주소 등록 (예: `https://<앱이름>.apps.tossmini.com`, 테스트용 GitHub Pages 주소)
   - 사용 API: 지오코더, WMTS
3. **GitHub 저장소**
   - 이 폴더를 새 저장소로 올리기
   - Settings → Secrets and variables → Actions → `DATA_GO_KR_KEY`, `VWORLD_KEY` 등록
   - Settings → Pages → Branch `main` / root 로 켜기
   - Actions → 「실거래 데이터 갱신」 → Run workflow (첫 실행은 좌표를 찾느라 몇 분 걸려요)
4. **앱 설정** — `app/index.html` 위쪽 `CONFIG`
   ```js
   const CONFIG = {
     DATA_URL: "https://<아이디>.github.io/<저장소>/data/complexes.json",
     VWORLD_KEY: "V-World 인증키"
   };
   ```
   비워두면 샘플 데이터 + 개발용 OpenStreetMap 지도로 돌아가요.

## 지역 추가

`pipeline/config.json` 의 `regions` 에 법정동 시군구 코드(5자리)를 추가하세요.
지역 1곳당 하루 API 호출은 12회(12개월)이고, 거래가 1,000건이 넘는 달은 페이지 수만큼 늘어나요.

## 테스트

```
node pipeline/test/run-mock-test.mjs
```
가짜 API 서버로 수집 → 해제거래 제외 → 페이지 나눔 → 좌표 실패 처리까지 확인해요. 실제 API는 키가 있어야 해서 여기서는 돌려보지 않았어요.

## 확인 필요

- V-World 지오코더 결과를 캐시로 저장해 쓰는 것이 이용약관상 괜찮은지 (공공 API라 일반적으로 가능하지만 확인 권장)
- 앱인토스 WebView에서 V-World 타일 도메인(api.vworld.kr) 접근 허용 여부
- 관리비·공급면적은 실거래 API에 없어서 면적 비례 추정치를 써요
