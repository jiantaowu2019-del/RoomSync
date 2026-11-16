import { defineConfig } from "@playwright/test";

const port = process.env.ROOMSYNC_E2E_PORT ?? "8765";
if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
  throw new Error("ROOMSYNC_E2E_PORT must be an integer between 1 and 65535.");
}
const origin = `http://127.0.0.1:${port}`;

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
    env: { ROOMSYNC_E2E_PORT: port },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
