import { defineConfig } from "@playwright/test";

const origin = "http://127.0.0.1:8765";

export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: origin,
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || undefined,
  },
  webServer: {
    command: "python -m tests.browser_server",
    cwd: "..",
    url: origin,
    timeout: 30_000,
  },
});
