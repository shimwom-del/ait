import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import aitDevtools from "@apps-in-toss/devtools/unplugin";

// 앱인토스 번들용 빌드: app/index.html 에 toss/bridge.js 를 붙여 dist/ 로 만듦 → ait build 가 .ait 로 묶음
// GitHub Pages 배포는 이 빌드를 쓰지 않고 app/ 를 그대로 올림
// 개발 서버(npm run dev)에서는 devtools 가 SDK 를 가짜(mock)로 바꾸고 오른쪽 아래 AIT 패널을 띄움
const BRIDGE_ID = "/ait-bridge.js";
const bridgeFile = fileURLToPath(new URL("./toss/bridge.js", import.meta.url));

// V-World 지도 키: 환경변수 → 없으면 .env 에서 읽어 빌드 결과에만 넣음 (저장소의 app/index.html 은 빈 값 유지)
function vworldKey() {
  if (process.env.VWORLD_KEY) return process.env.VWORLD_KEY.trim();
  try {
    const env = readFileSync(new URL("./.env", import.meta.url), "utf8");
    return env.match(/^\s*VWORLD_KEY\s*=\s*["']?([^"'\r\n]*)/m)?.[1].trim() || "";
  } catch { return ""; }
}

export default defineConfig(({ command }) => ({
  root: "app",
  base: "./",
  publicDir: false,
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [
    {
      name: "ait-bridge",
      resolveId: (id) => (id === BRIDGE_ID ? bridgeFile : null),
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          let out = html;
          if (command === "build") {
            const key = vworldKey();
            if (!key) this?.warn?.("VWORLD_KEY 없음 → 개발용 OSM 지도로 빌드");
            else if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error("VWORLD_KEY 형식이 이상해요");
            else if (!out.includes('VWORLD_KEY: ""')) throw new Error("app/index.html 에서 VWORLD_KEY 자리를 못 찾았어요");
            else out = out.replace('VWORLD_KEY: ""', `VWORLD_KEY: "${key}"`);
          }
          return { html: out, tags: [{ tag: "script", attrs: { type: "module", src: BRIDGE_ID }, injectTo: "head" }] };
        }
      }
    },
    aitDevtools.vite({ panel: false }) // 패널은 toss/bridge.js 에서 개발 때만 띄움
  ]
}));
