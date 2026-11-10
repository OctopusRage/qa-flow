import { defineConfig } from '@playwright/test';

// Copied into every run folder by qa-flow. Settings come from the environment
// the server sets, so the same spec replays against any base URL.
const env = process.env;
// A mixed run (probe-coder design-log/066) first replays library cases' saved specs,
// copied in as *.lib.spec.ts, each into its own results/output so the later
// flow.spec.ts pass doesn't wipe them. Outside that phase they are invisible, so
// the generating agent's `./pw test` never runs them.
const libPhase = env.QA_LIB_PHASE === '1';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  testIgnore: libPhase ? [] : ['**/*.lib.spec.ts'],
  timeout: Number(env.QA_TIMEOUT_MS ?? 300_000),
  expect: { timeout: 20_000 },
  workers: Number(env.QA_WORKERS ?? 1),
  retries: Number(env.QA_RETRIES ?? 0),
  reporter: [
    ['list'],
    ['json', { outputFile: env.QA_RESULTS_FILE ?? 'results.json' }],
    ['html', { outputFolder: env.QA_REPORT_DIR ?? 'report', open: 'never' }],
  ],
  outputDir: env.QA_OUTPUT_DIR ?? 'test-output',
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
