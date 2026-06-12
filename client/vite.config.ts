import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: proxy /api to the Express server so the client calls it same-origin.
// Prod: build straight into the server's public/ dir, which Express serves.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../server/public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
