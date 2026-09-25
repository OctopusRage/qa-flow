import { defineConfig } from '@playwright/test';

// Copied into every run folder by qa-flow. Settings come from the environment
// the server sets, so the same spec replays against any base URL.
const env = process.env;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: Number(env.QA_TIMEOUT_MS ?? 300_000),
  expect: { timeout: 20_000 },
  workers: Number(env.QA_WORKERS ?? 1),
  retries: Number(env.QA_RETRIES ?? 0),
  reporter: [
    ['list'],
    ['json', { outputFile: 'results.json' }],
    ['html', { outputFolder: 'report', open: 'never' }],
  ],
  outputDir: 'test-output',
  use: {
    baseURL: env.QA_BASE_URL,
    headless: env.QA_HEADLESS !== '0',
    viewport: { width: 1440, height: 900 },
    screenshot: 'on',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
    navigationTimeout: 60_000,
    actionTimeout: 30_000,
  },
});
