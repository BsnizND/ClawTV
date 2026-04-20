import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const configuredBasePath = process.env.CLAWTV_BASE_PATH?.trim();
const base = configuredBasePath
  ? `${configuredBasePath.replace(/\/+$/u, "").replace(/^([^/])/u, "/$1")}/`
  : "/ClawTV/";
const buildId = process.env.CLAWTV_BUILD_ID?.trim()
  || new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14);

export default defineConfig({
  plugins: [react()],
  base,
  define: {
    __CLAWTV_BUILD_ID__: JSON.stringify(buildId)
  },
  server: {
    port: 5173
  }
});
