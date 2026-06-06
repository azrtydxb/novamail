import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy /api to a local admin-api (override target with VITE_API_TARGET).
// In production the GUI is served by nginx which proxies /api to the admin-api.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
        // dev only: inject the admin API key (nginx does this in production)
        headers: process.env.ADMIN_API_KEY ? { "x-api-key": process.env.ADMIN_API_KEY } : undefined,
      },
    },
  },
  build: { outDir: "dist" },
});
