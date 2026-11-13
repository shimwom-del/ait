import { defineConfig } from "@apps-in-toss/web-framework/config";

// 앱인토스 설정. appName 은 콘솔에 등록한 이름과 같아야 해요 (딥링크 intoss://house-cost)
export default defineConfig({
  appName: "house-cost",
  permissions: [],
  webView: {},
  webBundleDir: "dist", // vite build 결과 (vite.config.js)
});
