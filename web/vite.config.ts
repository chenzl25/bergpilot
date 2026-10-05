import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `pnpm dev` serves the UI on :5173 and forwards /api to a BergPilot
// server started with `cargo run` (default 127.0.0.1:7878).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7878",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
