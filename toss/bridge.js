// 앱인토스 빌드에서만 들어가는 연결 파일. app/index.html 은 그대로 두고 필요한 SDK 기능만 window 에 넣어 줌
// (GitHub Pages 배포본에는 이 파일이 없어서 웹 공유·링크 복사로 동작)
// 개발 서버에서는 devtools 가 SDK 를 mock 으로 바꾸고, 아래에서 AIT 패널을 띄움 (빌드에는 안 들어감)
import { Share, getSchemeUri } from "@apps-in-toss/web-framework";

window.__AIT_SHARE__ = Share; // 카드 보내기: Share.createLink + Share.sendMessage
window.__AIT_SCHEME__ = () => { try { return getSchemeUri(); } catch { return ""; } }; // 공유 링크로 들어온 주소

if (import.meta.env.DEV) import("@apps-in-toss/devtools/panel");
