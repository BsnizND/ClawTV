import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const configuredBasePath = process.env.CLAWTV_BASE_PATH?.trim();
const base = configuredBasePath
  ? `${configuredBasePath.replace(/\/+$/u, "").replace(/^([^/])/u, "/$1")}/`
  : "/ClawTV/";

export default defineConfig({
  plugins: [react()],
  base,
  server: {
    port: 5173
  }
});
