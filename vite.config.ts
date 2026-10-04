import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Keep the browser on one origin in development. The API is intentionally
    // local-only, so a Vite proxy is safer than adding a broad CORS policy to it.
    // It also preserves SSE streaming for /api/jobs/stream.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${Number(process.env.PORT ?? 8787)}`,
        changeOrigin: false,
      },
    },
    // Windows + a home path containing a space: polling is far more reliable here.
    // Runtime artifacts (SQLite WAL files, downloads, and browser profiles) must
    // not trigger full-page reloads while the app is being used or tested.
    watch: {
      usePolling: true,
      ignored: ["**/data/**", "**/downloads/**", "**/.tmp-chrome/**"],
    },
  },
});
