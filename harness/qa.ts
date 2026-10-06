import { test as base, expect, type APIRequestContext, type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Copied into every run folder by qa-flow. Specs import { test, expect, v } from './qa'
// and wrap each user-visible action in qa.step(): a screenshot is taken after every
// step, passed or failed, and recorded in steps.jsonl for the dashboard. API tests use
// api.step() and the api.get/post/… helpers instead: every call is recorded with its step
// (method, URL, status, masked bodies), and a test that never asks for page opens no browser.

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

export type ApiCall = {
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  request: string | null;
  response: string | null;
  error: string | null;
};

type FetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;

export type Api = {
  /** A named API step: the calls made inside it are its report, no screenshot. */
  step<T>(title: string, body: () => Promise<T>): Promise<T>;
  get(url: string, opts?: FetchOptions): Promise<APIResponse>;
  post(url: string, opts?: FetchOptions): Promise<APIResponse>;
  put(url: string, opts?: FetchOptions): Promise<APIResponse>;
  patch(url: string, opts?: FetchOptions): Promise<APIResponse>;
  delete(url: string, opts?: FetchOptions): Promise<APIResponse>;
  head(url: string, opts?: FetchOptions): Promise<APIResponse>;
  /** Any method: opts.method, default GET. */
  fetch(url: string, opts?: FetchOptions): Promise<APIResponse>;
};

// ---- masking: recorded bodies end up in the dashboard and Slack ----------------

const SECRET_VALUES: string[] = (JSON.parse(process.env.QA_SECRET_KEYS ?? '[]') as string[])
  .map((k) => vars[k])
  .filter((x): x is string => typeof x === 'string' && x.length >= 3)
  .sort((a, b) => b.length - a.length);
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authori[sz]ation|api[-_]?key|cookie|otp|session|credential/i;
const BODY_LIMIT = 4000;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, x]) => [k, SENSITIVE_KEY.test(k) && (typeof x === 'string' || typeof x === 'number') ? '••••••' : redact(x)]),
    );
  }
  return value;
}

function maskText(text: string): string {
  let out = text;
  try {
    out = JSON.stringify(redact(JSON.parse(text)), null, 2);
  } catch {
    // Not JSON: secret values are still replaced below.
  }
  for (const secret of SECRET_VALUES) out = out.split(secret).join('••••••');
  return out.length > BODY_LIMIT ? `${out.slice(0, BODY_LIMIT)}\n… (${out.length - BODY_LIMIT} more characters)` : out;
}

function describeRequest(opts: FetchOptions | undefined): string | null {
  if (!opts) return null;
  if (opts.data !== undefined) return maskText(typeof opts.data === 'string' ? opts.data : Buffer.isBuffer(opts.data) ? `<${opts.data.length} bytes>` : JSON.stringify(opts.data));
  if (opts.form !== undefined) return maskText(JSON.stringify(opts.form instanceof URLSearchParams ? Object.fromEntries(opts.form) : opts.form));
  if (opts.multipart !== undefined) {
    const entries = opts.multipart instanceof FormData ? [...opts.multipart.keys()] : Object.keys(opts.multipart);
    return `multipart: ${entries.join(', ')}`;
  }
  return null;
}

async function describeResponse(res: APIResponse): Promise<string> {
  const type = res.headers()['content-type'] ?? '';
  const body = await res.body();
  if (!body.length) return '';
  if (/json|text|xml|html|javascript|urlencoded/.test(type) || !type) return maskText(body.toString('utf8'));
  return `<${type}, ${body.length} bytes>`;
}

// ---- step manifest ------------------------------------------------------------

/** One per test: numbers the steps and collects API calls made during each. */
class StepLog {
  index = 0;
  calls: ApiCall[] = [];
  constructor(private testInfo: TestInfo) {}

  write(record: { title: string; status: string; error?: string; startedAt: number; calls: ApiCall[]; screenshot: string | null; url: string | null }) {
    const t = this.testInfo;
    appendFileSync(
      MANIFEST,
      JSON.stringify({
        testId: t.testId,
        test: t.titlePath.slice(1).join(' › '),
        retry: t.retry,
        index: this.index,
        title: record.title,
        status: record.status,
        error: record.error ?? null,
        durationMs: Date.now() - record.startedAt,
        screenshot: record.screenshot,
        url: record.url,
        calls: record.calls.length ? record.calls : undefined,
        at: new Date().toISOString(),
      }) + '\n',
    );
  }
}

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

export const test = base.extend<{ qa: QA; api: Api; _stepLog: StepLog }>({
  _stepLog: async ({}, use, testInfo) => {
    await use(new StepLog(testInfo));
  },

  qa: async ({ page, _stepLog: log }, use, testInfo) => {
    mkdirSync(SHOTS, { recursive: true });
    let active = page;

    const capture = async (title: string, status: string, startedAt: number, calls: ApiCall[], error?: string, opts?: StepOptions) => {
      log.index += 1;
      const target = opts?.page ?? active;
      const file = `${testInfo.testId}-r${testInfo.retry}-${String(log.index).padStart(2, '0')}-${slug(title)}.png`;
      let screenshot: string | null = join('screenshots', file);
      try {
        if (target.isClosed()) throw new Error('page closed');
        await target.screenshot({ path: join(RUN_DIR, screenshot), fullPage: opts?.fullPage ?? false, timeout: 15_000 });
        await testInfo.attach(`${String(log.index).padStart(2, '0')} ${title}`, { path: join(RUN_DIR, screenshot), contentType: 'image/png' });
      } catch {
        screenshot = null;
      }
      log.write({ title, status, error, startedAt, calls, screenshot, url: target.isClosed() ? null : target.url() });
    };

    const qa: QA = {
      step: (title, body, opts) =>
        test.step(title, async () => {
          const startedAt = Date.now();
          const mark = log.calls.length;
          try {
            const result = await body();
            await capture(title, 'passed', startedAt, log.calls.splice(mark), undefined, opts);
            return result;
          } catch (e) {
            await capture(title, 'failed', startedAt, log.calls.splice(mark), errorText(e), opts);
            throw e;
          }
        }),
      shot: (label, p) => capture(label, 'info', Date.now(), [], undefined, { page: p }),
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

  // Its own request context (no browser): baseURL is the API_BASE_URL variable when set,
  // else the run's base URL. A leading slash ('/api/v1/…') resolves from the host root.
  api: async ({ playwright, _stepLog: log }, use) => {
    const ctx = await playwright.request.newContext({ baseURL: vars.API_BASE_URL || process.env.QA_BASE_URL, ignoreHTTPSErrors: true });
    const send = async (url: string, opts: FetchOptions = {}) => {
      const startedAt = Date.now();
      const method = (opts.method ?? 'GET').toUpperCase();
      const call: ApiCall = { method, url, status: null, durationMs: 0, request: describeRequest(opts), response: null, error: null };
      log.calls.push(call);
      try {
        const res = await ctx.fetch(url, { ...opts, method });
        call.url = res.url();
        call.status = res.status();
        call.response = await describeResponse(res).catch(() => null);
        return res;
      } catch (e) {
        call.error = errorText(e);
        throw e;
      } finally {
        call.durationMs = Date.now() - startedAt;
      }
    };
    const api: Api = {
      step: (title, body) =>
        test.step(title, async () => {
          const startedAt = Date.now();
          const mark = log.calls.length;
          const done = (status: string, error?: string) => {
            log.index += 1;
            log.write({ title, status, error, startedAt, calls: log.calls.splice(mark), screenshot: null, url: null });
          };
          try {
            const result = await body();
            done('passed');
            return result;
          } catch (e) {
            done('failed', errorText(e));
            throw e;
          }
        }),
      fetch: (url, opts) => send(url, opts),
      get: (url, opts) => send(url, { ...opts, method: 'GET' }),
      post: (url, opts) => send(url, { ...opts, method: 'POST' }),
      put: (url, opts) => send(url, { ...opts, method: 'PUT' }),
      patch: (url, opts) => send(url, { ...opts, method: 'PATCH' }),
      delete: (url, opts) => send(url, { ...opts, method: 'DELETE' }),
      head: (url, opts) => send(url, { ...opts, method: 'HEAD' }),
    };
    await use(api);
    await ctx.dispose();
  },
});

export { expect };
