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
      },
    },
  },
  build: { outDir: "dist" },
});
