import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client lives in src/client and is built into dist/, which the game server serves.
// In dev (`npm run dev`), Vite runs on 5173 and proxies API, auth and WebSocket traffic to the server.
export default defineConfig({
  root: "src/client",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    proxy: {
      "/api": "http://localhost:3001",
      "/auth": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
