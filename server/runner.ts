import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT,
  RUNS_DIR,
  getRun,
  getSettings,
  getTemplate,
  now,
  updateRun,
  type Run,
  type RunStatus,
  type RunSummary,
  type Variable,
} from './db.ts';
import { generateSpec } from './agent.ts';

const PW_CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const HARNESS = join(ROOT, 'harness');

export const runDir = (id: number) => join(RUNS_DIR, String(id));

// ---- live events ------------------------------------------------------------

export const events = new EventEmitter();
events.setMaxListeners(100);

export type RunEvent = { runId: number; type: 'log'; line: string } | { runId: number; type: 'status'; status: RunStatus };

export function log(runId: number, line: string) {
  const text = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  appendFileSync(join(runDir(runId), 'run.log'), text + '\n');
  events.emit('event', { runId, type: 'log', line: text } satisfies RunEvent);
}

function setStatus(runId: number, status: RunStatus, patch: Partial<Run> = {}) {
  updateRun(runId, { status, ...patch });
  events.emit('event', { runId, type: 'status', status } satisfies RunEvent);
}

// ---- queue ----------------------------------------------------------------

const queue: number[] = [];
let active: { runId: number; abort: AbortController; child?: ChildProcess } | null = null;

export function enqueue(runId: number) {
  mkdirSync(runDir(runId), { recursive: true });
  queue.push(runId);
  log(runId, `Queued (${queue.length} in queue)`);
  void pump();
}

export function cancel(runId: number): boolean {
  const i = queue.indexOf(runId);
  if (i >= 0) {
    queue.splice(i, 1);
    setStatus(runId, 'canceled', { finished_at: now() });
    log(runId, 'Canceled before start');
    return true;
  }
  if (active?.runId === runId) {
    active.abort.abort();
    active.child?.kill('SIGTERM');
    return true;
  }
  return false;
}

export const queueState = () => ({ active: active?.runId ?? null, queued: [...queue] });

async function pump() {
  if (active || !queue.length) return;
  const runId = queue.shift()!;
  active = { runId, abort: new AbortController() };
  try {
    await execute(runId, active.abort);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(runId, `✖ ${message}`);
    setStatus(runId, active.abort.signal.aborted ? 'canceled' : 'error', { error: message, finished_at: now() });
  } finally {
    // Secret values only live in the environment, but drop anything a spec may have written.
    rmSync(join(runDir(runId), 'scratch'), { recursive: true, force: true });
    active = null;
    void pump();
  }
}

// ---- execution --------------------------------------------------------------

/** Global settings < template < run overrides. */
export function mergedVariables(run: Run): Variable[] {
  const map = new Map<string, Variable>();
  const settings = getSettings();
  const template = run.template_id ? getTemplate(run.template_id) : undefined;
  for (const list of [settings.variables, template?.variables ?? [], run.variables]) {
    for (const item of list) {
      if (!item.key) continue;
      const prev = map.get(item.key);
      // An empty override keeps the earlier value (e.g. a secret set in Settings).
      if (prev && item.value === '') continue;
      map.set(item.key, { ...item, secret: item.secret || prev?.secret });
    }
  }
  return [...map.values()];
}

function playwrightEnv(run: Run, dir: string): NodeJS.ProcessEnv {
  const settings = getSettings();
  const vars = Object.fromEntries(mergedVariables(run).map((v) => [v.key, v.value]));
  const baseUrl = run.base_url.endsWith('/') ? run.base_url : `${run.base_url}/`;
  return {
    ...process.env,
    QA_RUN_DIR: dir,
    QA_BASE_URL: baseUrl,
    QA_VARS: JSON.stringify(vars),
    QA_HEADLESS: settings.headless ? '1' : '0',
    QA_WORKERS: String(settings.workers),
    QA_TIMEOUT_MS: String(settings.testTimeoutSec * 1000),
    FORCE_COLOR: '0',
  };
}

function prepareDir(run: Run): string {
  const dir = runDir(run.id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(HARNESS, 'playwright.config.ts'), join(dir, 'playwright.config.ts'));
  copyFileSync(join(HARNESS, 'qa.ts'), join(dir, 'qa.ts'));
  // ./pw is the only way the generating agent may run Playwright.
  writeFileSync(join(dir, 'pw'), `#!/bin/sh\nexec "${process.execPath}" "${PW_CLI}" "$@"\n`);
  chmodSync(join(dir, 'pw'), 0o755);
  return dir;
}

function resetResults(dir: string) {
  for (const p of ['screenshots', 'steps.jsonl', 'results.json', 'report', 'test-output', 'result.json']) {
    rmSync(join(dir, p), { recursive: true, force: true });
  }
}

async function execute(runId: number, abort: AbortController) {
  const run = getRun(runId);
  if (!run) return;
  const dir = prepareDir(run);
  const env = playwrightEnv(run, dir);
  updateRun(runId, { started_at: now(), error: null });

  if (run.mode === 'generate') {
    setStatus(runId, 'generating');
    const template = run.template_id ? getTemplate(run.template_id) : undefined;
    const existing = template?.spec || '';
    if (existing && !existsSync(join(dir, 'flow.spec.ts'))) writeFileSync(join(dir, 'flow.spec.ts'), existing);
    const { costUsd } = await generateSpec({ run, dir, env, variables: mergedVariables(run), existingSpec: existing, abort, log: (l) => log(runId, l) });
    updateRun(runId, { cost_usd: costUsd });
    if (!existsSync(join(dir, 'flow.spec.ts'))) throw new Error('The agent finished without writing flow.spec.ts');
    log(runId, '— Final verification run of flow.spec.ts —');
  } else {
    const template = run.template_id ? getTemplate(run.template_id) : undefined;
    if (!template?.spec) throw new Error('Template has no spec yet. Generate it with AI first.');
    writeFileSync(join(dir, 'flow.spec.ts'), template.spec);
  }

  if (abort.signal.aborted) throw new Error('Canceled');
  setStatus(runId, 'running');
  resetResults(dir);
  const code = await playwright(runId, dir, env, abort);
  if (abort.signal.aborted) throw new Error('Canceled');

  const result = collectResults(dir);
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  const s = result.summary;
  const passed = code === 0 && s.failed === 0 && s.total > 0;
  log(runId, `Done: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped${s.flaky ? `, ${s.flaky} flaky` : ''} in ${(s.durationMs / 1000).toFixed(1)}s`);
  const missing = result.tests.filter((t) => t.status !== 'skipped' && !t.steps.some((st) => st.screenshot));
  if (missing.length) log(runId, `⚠ ${missing.length} test(s) have no qa.step() screenshots: ${missing.map((t) => t.title).join(', ')}`);
  setStatus(runId, passed ? 'passed' : s.total === 0 ? 'error' : 'failed', {
    summary: s,
    finished_at: now(),
    error: s.total === 0 ? result.error ?? 'No tests ran' : null,
  });
}

function playwright(runId: number, dir: string, env: NodeJS.ProcessEnv, abort: AbortController): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PW_CLI, 'test', 'flow.spec.ts', '-c', 'playwright.config.ts'], { cwd: dir, env });
    if (active?.runId === runId) active.child = child;
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) log(runId, l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) log(runId, buf);
      if (abort.signal.aborted) return reject(new Error('Canceled'));
      resolve(code ?? 1);
    });
  });
}

// ---- results ----------------------------------------------------------------

export type StepRecord = {
  testId: string;
  test: string;
  retry: number;
  index: number;
  title: string;
  status: 'passed' | 'failed' | 'info';
  error: string | null;
  durationMs: number;
  screenshot: string | null;
  url: string | null;
  at: string;
};

export type TestResult = {
  id: string;
  title: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped' | 'flaky' | 'timedOut' | 'interrupted';
  durationMs: number;
  retries: number;
  error: string | null;
  steps: StepRecord[];
  finalScreenshot: string | null;
};

export type RunResult = { summary: RunSummary; tests: TestResult[]; error?: string };

type PwResult = { status: string; duration: number; retry: number; errors?: { message?: string }[]; error?: { message?: string }; attachments?: { name: string; path?: string }[] };
type PwTest = { testId?: string; status?: string; results: PwResult[] };
type PwSpec = { id: string; title: string; file: string; tests: PwTest[] };
type PwSuite = { title: string; specs?: PwSpec[]; suites?: PwSuite[] };

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

export function collectResults(dir: string): RunResult {
  const stepsFile = join(dir, 'steps.jsonl');
  const steps: StepRecord[] = existsSync(stepsFile)
    ? readFileSync(stepsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const summary: RunSummary = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 };
  const resultsFile = join(dir, 'results.json');
  if (!existsSync(resultsFile)) return { summary, tests: [], error: 'Playwright produced no results (see the log)' };

  const json = JSON.parse(readFileSync(resultsFile, 'utf8')) as {
    suites: PwSuite[];
    stats?: { duration: number };
    errors?: { message?: string }[];
  };
  const tests: TestResult[] = [];
  const walk = (suite: PwSuite, path: string[]) => {
    const here = suite.title && !suite.title.endsWith('.spec.ts') ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const last = t.results.at(-1);
        const outcome = t.status; // expected | unexpected | flaky | skipped
        const status: TestResult['status'] =
          outcome === 'skipped' ? 'skipped' : outcome === 'flaky' ? 'flaky' : outcome === 'expected' ? 'passed' : last?.status === 'timedOut' ? 'timedOut' : 'failed';
        const lastRetry = last?.retry ?? 0;
        const id = t.testId ?? spec.id;
        const finalShot = last?.attachments?.find((a) => a.name === 'screenshot' && a.path)?.path;
        const err = last?.errors?.map((e) => e.message).filter(Boolean).join('\n') || last?.error?.message || null;
        tests.push({
          id,
          title: [...here, spec.title].join(' › '),
          file: spec.file,
          status,
          durationMs: t.results.reduce((a, r) => a + r.duration, 0),
          retries: lastRetry,
          error: err ? strip(err).slice(0, 4000) : null,
          steps: steps.filter((s) => s.testId === id && s.retry === lastRetry),
          finalScreenshot: finalShot ? finalShot.replace(`${dir}/`, '') : null,
        });
      }
    }
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of json.suites) walk(s, []);

  for (const t of tests) {
    summary.total += 1;
    if (t.status === 'passed') summary.passed += 1;
    else if (t.status === 'skipped') summary.skipped += 1;
    else if (t.status === 'flaky') {
      summary.flaky += 1;
      summary.passed += 1;
    } else summary.failed += 1;
  }
  summary.durationMs = Math.round(json.stats?.duration ?? tests.reduce((a, t) => a + t.durationMs, 0));
  const error = json.errors?.length ? strip(json.errors.map((e) => e.message).join('\n')).slice(0, 4000) : undefined;
  return { summary, tests, error };
}

export function readResult(runId: number): RunResult | null {
  const f = join(runDir(runId), 'result.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}
