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
  type TokenUsage,
  type Variable,
} from './db.ts';
import { generateSpec } from './agent.ts';
import { MB, fmtBytes, sample } from './resources.ts';

const PW_CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const HARNESS = join(ROOT, 'harness');

export const runDir = (id: number) => join(RUNS_DIR, String(id));

// ---- live events ------------------------------------------------------------

export const events = new EventEmitter();
events.setMaxListeners(100);

export type RunEvent =
  | { runId: number; type: 'log'; line: string }
  | { runId: number; type: 'status'; status: RunStatus }
  | { runId: number; type: 'usage'; tokens: TokenUsage; costUsd: number | null };

export function log(runId: number, line: string) {
  const text = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  appendFileSync(join(runDir(runId), 'run.log'), text + '\n');
  events.emit('event', { runId, type: 'log', line: text } satisfies RunEvent);
}

function setStatus(runId: number, status: RunStatus, patch: Partial<Run> = {}) {
  updateRun(runId, { status, ...patch });
  events.emit('event', { runId, type: 'status', status } satisfies RunEvent);
}

// ---- scheduler ----------------------------------------------------------------
//
// Runs start in queue order. Whether the next one may start now depends on the concurrency
// setting: "fixed" allows maxConcurrent at once; "auto" also needs spare CPU and enough
// available memory for the new run's estimated footprint, counting what recently started
// runs will still grow into. One run may always start, so a busy machine queues rather than stalls.

type Active = { runId: number; abort: AbortController; child?: ChildProcess; mode: Run['mode']; templateId: number | null; startedAt: number; costMb: number };

const queue: number[] = [];
const active = new Map<number, Active>();
const waiting = new Map<number, string>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;

// A run's browser and agent processes take a while to reach full size.
const WARMUP_MS = 45_000;

/** Rough peak memory of one run: Chromium per Playwright worker, plus the Claude agent when generating. */
export function estimateMb(mode: Run['mode'], workers: number) {
  return (mode === 'generate' ? 900 : 300) + 450 * Math.max(1, workers);
}

type Admission = { ok: true } | { ok: false; reason: string; blocksQueue: boolean };

function admit(run: Run): Admission {
  const s = getSettings();
  const cap = Math.max(1, s.maxConcurrent);
  if (active.size >= cap) return { ok: false, reason: cap === 1 ? 'The run slot is busy (limit 1)' : `All ${cap} run slots are busy`, blocksQueue: true };
  if (run.template_id && [...active.values()].some((a) => a.templateId === run.template_id)) {
    // Two runs of one flow would share the same test accounts and data on the target.
    return { ok: false, reason: 'Waiting for the running copy of this template to finish', blocksQueue: false };
  }
  if (active.size === 0 || s.concurrencyMode === 'fixed') return { ok: true };

  const r = sample();
  if (r.cpuPercent > s.cpuLimitPercent) return { ok: false, reason: `CPU busy (${r.cpuPercent}% > ${s.cpuLimitPercent}% limit)`, blocksQueue: true };
  const now = Date.now();
  // Runs still warming up have not claimed their memory yet: reserve the rest of their estimate.
  const reserved = [...active.values()].reduce((sum, a) => sum + (now - a.startedAt < WARMUP_MS ? a.costMb * MB * (1 - (now - a.startedAt) / WARMUP_MS) : 0), 0);
  const need = estimateMb(run.mode, s.workers) * MB;
  const spare = r.memAvailable - reserved - s.memoryHeadroomMb * MB;
  if (spare < need) {
    return { ok: false, reason: `Low memory (${fmtBytes(Math.max(0, r.memAvailable - reserved))} free, needs ${fmtBytes(need)} + ${fmtBytes(s.memoryHeadroomMb * MB)} headroom)`, blocksQueue: true };
  }
  return { ok: true };
}

export function enqueue(runId: number) {
  mkdirSync(runDir(runId), { recursive: true });
  queue.push(runId);
  log(runId, `Queued (${queue.length} waiting, ${active.size} running)`);
  pump();
}

export function cancel(runId: number): boolean {
  const i = queue.indexOf(runId);
  if (i >= 0) {
    queue.splice(i, 1);
    waiting.delete(runId);
    setStatus(runId, 'canceled', { finished_at: now() });
    log(runId, 'Canceled before start');
    pump();
    return true;
  }
  const a = active.get(runId);
  if (a) {
    a.abort.abort();
    a.child?.kill('SIGTERM');
    return true;
  }
  return false;
}

export const isActive = (runId: number) => active.has(runId);

export function queueState() {
  return {
    running: [...active.keys()],
    queued: [...queue],
    waiting: Object.fromEntries(queue.map((id) => [id, waiting.get(id) ?? 'Next in line'])),
  };
}

export function schedulerState() {
  const s = getSettings();
  return {
    mode: s.concurrencyMode,
    maxConcurrent: s.maxConcurrent,
    memoryHeadroomMb: s.memoryHeadroomMb,
    cpuLimitPercent: s.cpuLimitPercent,
    resources: sample(),
    running: [...active.values()].map((a) => ({ runId: a.runId, mode: a.mode, startedAt: new Date(a.startedAt).toISOString(), estimateMb: a.costMb })),
    queued: queue.map((id) => ({ runId: id, reason: waiting.get(id) ?? 'Next in line' })),
  };
}

function noteWaiting(runId: number, reason: string) {
  if (waiting.get(runId) === reason) return;
  waiting.set(runId, reason);
  log(runId, `⏳ ${reason}`);
}

function pump() {
  clearTimeout(retryTimer);
  for (let i = 0; i < queue.length; ) {
    const run = getRun(queue[i]);
    if (!run || run.status !== 'queued') {
      queue.splice(i, 1);
      continue;
    }
    const verdict = admit(run);
    if (verdict.ok) {
      queue.splice(i, 1);
      waiting.delete(run.id);
      start(run);
      continue; // re-check the same index: the queue shifted
    }
    noteWaiting(run.id, verdict.reason);
    // Resource limits hold the whole queue in order; a busy template only holds its own runs.
    if (verdict.blocksQueue) {
      for (const id of queue.slice(i + 1)) noteWaiting(id, verdict.reason);
      break;
    }
    i += 1;
  }
  // Resources change on their own: look again shortly.
  if (queue.length) retryTimer = setTimeout(pump, 3000);
}

function start(run: Run) {
  const settings = getSettings();
  const entry: Active = {
    runId: run.id,
    abort: new AbortController(),
    mode: run.mode,
    templateId: run.template_id,
    startedAt: Date.now(),
    costMb: estimateMb(run.mode, settings.workers),
  };
  active.set(run.id, entry);
  if (active.size > 1) log(run.id, `▶ Starting alongside ${active.size - 1} other run(s)`);
  void execute(run.id, entry.abort)
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      log(run.id, `✖ ${message}`);
      setStatus(run.id, entry.abort.signal.aborted ? 'canceled' : 'error', { error: message, finished_at: now() });
    })
    .finally(() => {
      // Secret values only live in the environment, but drop anything a spec may have written.
      rmSync(join(runDir(run.id), 'scratch'), { recursive: true, force: true });
      active.delete(run.id);
      pump();
    });
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
    // Persist the tally as it grows (throttled) so a canceled or crashed run still shows its spend.
    let lastSave = 0;
    const latest: { value: { tokens: TokenUsage; costUsd: number | null } | null } = { value: null };
    const saveUsage = (tokens: TokenUsage, costUsd: number | null, force = false) => {
      latest.value = { tokens, costUsd };
      events.emit('event', { runId, type: 'usage', tokens, costUsd } satisfies RunEvent);
      if (force || Date.now() - lastSave > 3000) {
        lastSave = Date.now();
        updateRun(runId, { tokens, ...(costUsd != null ? { cost_usd: costUsd } : {}) });
      }
    };
    try {
      const { costUsd, tokens } = await generateSpec({
        run,
        dir,
        env,
        variables: mergedVariables(run),
        existingSpec: existing,
        abort,
        log: (l) => log(runId, l),
        onUsage: (t, c) => saveUsage(t, c),
      });
      saveUsage(tokens, costUsd, true);
    } finally {
      // Canceled or failed mid-way: keep what was spent so far.
      const last = latest.value;
      if (last) updateRun(runId, { tokens: last.tokens, ...(last.costUsd != null ? { cost_usd: last.costUsd } : {}) });
    }
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
    const entry = active.get(runId);
    if (entry) entry.child = child;
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
