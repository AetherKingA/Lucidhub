import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard lives in src/client and is built into dist/, which the hub server serves.
// In dev (`npm run dev`), Vite runs on 5174 and proxies API and auth traffic to the server.
export default defineConfig({
  root: "src/client",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/api/": "http://localhost:3100",
      "/auth/": "http://localhost:3100",
    },
  },
});
