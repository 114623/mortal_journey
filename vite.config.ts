import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    proxy: {
      // 文生图 dev 代理：浏览器请求 /ark-api/... 由 dev server 转发到火山方舟 Ark，
      // 规避浏览器直连 Ark 的 CORS 限制（Ark 为服务端 API，不发 CORS 头）。
      // 详见 src/image_generate/volcImageBridge.ts 的 resolveEndpoint()。
      "/ark-api": {
        target: "https://ark.cn-beijing.volces.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/ark-api/, "/api/v3"),
      },
    },
  },
});
