import { test as base, expect, type Page } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Copied into every run folder by qa-flow. Specs import { test, expect, v } from './qa'
// and wrap each user-visible action in qa.step(): a screenshot is taken after every
// step, passed or failed, and recorded in steps.jsonl for the dashboard.

const RUN_DIR = process.env.QA_RUN_DIR ?? process.cwd();
const SHOTS = join(RUN_DIR, 'screenshots');
const MANIFEST = join(RUN_DIR, 'steps.jsonl');

/** Run variables (global settings < template < run overrides). */
export const vars: Record<string, string> = JSON.parse(process.env.QA_VARS ?? '{}');

/** A required variable; fails the test with a clear message when missing. */
export function v(key: string): string {
  const value = vars[key];
  if (value === undefined || value === '') throw new Error(`Missing variable ${key} (set it in Settings, the template or the run)`);
  return value;
}

type StepOptions = { page?: Page; fullPage?: boolean };

export type QA = {
  /** A named step. Screenshot of the active page is saved after it, pass or fail. */
  step<T>(title: string, body: () => Promise<T>, opts?: StepOptions): Promise<T>;
  /** An extra screenshot outside a step. */
  shot(label: string, page?: Page): Promise<void>;
  /** Make another page (a second session) the default screenshot target. */
  use(page: Page): void;
  /** Exploration helper: accessibility snapshot + screenshot into scratch/dumps/. */
  dump(label: string, page?: Page): Promise<void>;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2000);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

export const test = base.extend<{ qa: QA }>({
  qa: async ({ page }, use, testInfo) => {
    mkdirSync(SHOTS, { recursive: true });
    let active = page;
    let index = 0;

    const capture = async (title: string, status: string, startedAt: number, error?: string, opts?: StepOptions) => {
      index += 1;
      const target = opts?.page ?? active;
      const file = `${testInfo.testId}-r${testInfo.retry}-${String(index).padStart(2, '0')}-${slug(title)}.png`;
      let screenshot: string | null = join('screenshots', file);
      try {
        if (target.isClosed()) throw new Error('page closed');
        await target.screenshot({ path: join(RUN_DIR, screenshot), fullPage: opts?.fullPage ?? false, timeout: 15_000 });
        await testInfo.attach(`${String(index).padStart(2, '0')} ${title}`, { path: join(RUN_DIR, screenshot), contentType: 'image/png' });
      } catch {
        screenshot = null;
      }
      appendFileSync(
        MANIFEST,
        JSON.stringify({
          testId: testInfo.testId,
          test: testInfo.titlePath.slice(1).join(' › '),
          retry: testInfo.retry,
          index,
          title,
          status,
          error: error ?? null,
          durationMs: Date.now() - startedAt,
          screenshot,
          url: target.isClosed() ? null : target.url(),
          at: new Date().toISOString(),
        }) + '\n',
      );
    };

    const qa: QA = {
      step: (title, body, opts) =>
        test.step(title, async () => {
          const startedAt = Date.now();
          try {
            const result = await body();
            await capture(title, 'passed', startedAt, undefined, opts);
            return result;
          } catch (e) {
            await capture(title, 'failed', startedAt, errorText(e), opts);
            throw e;
          }
        }),
      shot: (label, p) => capture(label, 'info', Date.now(), undefined, { page: p }),
      use: (p) => {
        active = p;
      },
      dump: async (label, p) => {
        const target = p ?? active;
        const dir = join(RUN_DIR, 'scratch', 'dumps');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${slug(label)}.yml`), `# ${target.url()}\n${await target.locator('body').ariaSnapshot()}`);
        await target.screenshot({ path: join(dir, `${slug(label)}.png`) });
      },
    };
    await use(qa);
  },
});

export { expect };
