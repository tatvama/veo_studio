import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = process.env.VEO_API ?? "http://localhost:8100";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api/ws": { target: API.replace("http", "ws"), ws: true },
      "/api": { target: API, changeOrigin: false },
      "/media": { target: API, changeOrigin: false },
    },
  },
});
