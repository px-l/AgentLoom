import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: 'canvas.perf.ts',
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  reporter: 'list',
});
