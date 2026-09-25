import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ROOT,
  RUNS_DIR,
  createRun,
  deleteRun,
  deleteTemplate,
  getRun,
  getSettings,
  getTemplate,
  listRuns,
  searchRuns,
  usageSince,
  listTemplates,
  rememberBaseUrl,
  saveSettings,
  saveTemplate,
  updateRun,
  now,
  type Run,
  type Settings,
  type Variable,
} from './db.ts';
import { cancel, enqueue, events, isActive, queueState, readResult, runDir, schedulerState, type RunEvent, type RunResult } from './runner.ts';
import { authTest, postReport, resolveTarget } from './slack.ts';
import { registerMcp } from './mcp.ts';
import { mcpInstall, mcpStatus, mcpUninstall } from './mcp-install.ts';

const PORT = Number(process.env.PORT ?? 4777);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024 });

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
app.setErrorHandler((err, _req, reply) => {
  const status = err instanceof HttpError ? err.status : (err as { statusCode?: number }).statusCode ?? 500;
  reply.status(status).send({ error: err instanceof Error ? err.message : String(err) });
});

// Local app: a web page on another origin must not be able to drive it (runs, Slack posts, installs).
app.addHook('onRequest', async (req, reply) => {
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return reply.status(403).send({ error: 'Origin not allowed' });
  }
});

const idParam = (p: unknown) => {
  const id = Number((p as { id: string }).id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Bad id');
  return id;
};
const sourceOf = (req: { headers: Record<string, unknown> }) => (req.headers['x-qa-source'] === 'mcp' ? 'mcp' : 'ui');
const mustRun = (id: number) => getRun(id) ?? (() => { throw new HttpError(404, 'Run not found'); })();

// ---- settings -------------------------------------------------------------

const hint = (s: string) => (s ? `…${s.slice(-4)}` : '');

function publicSettings(s: Settings) {
  return {
    ...s,
    slackToken: '',
    slackTokenHint: hint(s.slackToken),
    anthropicApiKey: '',
    anthropicApiKeyHint: hint(s.anthropicApiKey),
    variables: s.variables.map((v) => (v.secret ? { ...v, value: '', isSet: v.value !== '' } : v)),
  };
}

app.get('/api/settings', async () => publicSettings(getSettings()));

app.put('/api/settings', async (req) => {
  const body = req.body as Partial<Settings> & { clearSlackToken?: boolean; clearAnthropicApiKey?: boolean };
  const current = getSettings();
  const patch: Partial<Settings> = {};
  for (const k of ['slackChannel', 'model', 'maxTurns', 'headless', 'workers', 'testTimeoutSec', 'baseUrls', 'concurrencyMode', 'maxConcurrent', 'memoryHeadroomMb', 'cpuLimitPercent'] as const) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }
  if (body.slackToken) patch.slackToken = body.slackToken.trim();
  if (body.clearSlackToken) patch.slackToken = '';
  if (body.anthropicApiKey) patch.anthropicApiKey = body.anthropicApiKey.trim();
  if (body.clearAnthropicApiKey) patch.anthropicApiKey = '';
  if (body.variables) {
    // Secrets come back blank from GET: blank means "keep the stored value".
    patch.variables = body.variables
      .filter((v) => v.key.trim())
      .map((v) => {
        const key = v.key.trim();
        const prev = current.variables.find((p) => p.key === key);
        return { key, value: v.secret && v.value === '' && prev ? prev.value : v.value, secret: !!v.secret };
      });
  }
  saveSettings(patch);
  return publicSettings(getSettings());
});

app.post('/api/settings/slack-test', async (req) => {
  const token = (req.body as { token?: string } | undefined)?.token || getSettings().slackToken;
  if (!token) throw new HttpError(400, 'No Slack token saved');
  return authTest(token);
});

// ---- templates ------------------------------------------------------------

function templateStats(id: number) {
  const runs = listRuns(20, id);
  return { lastRun: runs[0] ?? null, runCount: runs.length };
}

app.get('/api/templates', async () => listTemplates().map((t) => ({ ...t, ...templateStats(t.id) })));

app.get('/api/templates/:id', async (req) => {
  const t = getTemplate(idParam(req.params));
  if (!t) throw new HttpError(404, 'Template not found');
  return { ...t, runs: listRuns(30, t.id) };
});

function templateBody(body: Record<string, unknown>) {
  const name = String(body.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Name is required');
  return {
    name,
    description: String(body.description ?? ''),
    instruction: String(body.instruction ?? ''),
    base_url: String(body.base_url ?? ''),
    spec: String(body.spec ?? ''),
    variables: ((body.variables as Variable[]) ?? []).filter((v) => v.key?.trim()).map((v) => ({ key: v.key.trim(), value: v.value ?? '' })),
  };
}

app.post('/api/templates', async (req) => saveTemplate(templateBody(req.body as Record<string, unknown>)));

app.put('/api/templates/:id', async (req) => {
  const id = idParam(req.params);
  if (!getTemplate(id)) throw new HttpError(404, 'Template not found');
  return saveTemplate({ id, ...templateBody(req.body as Record<string, unknown>) });
});

app.delete('/api/templates/:id', async (req) => {
  deleteTemplate(idParam(req.params));
  return { ok: true };
});

// ---- runs -----------------------------------------------------------------

app.get('/api/runs', async (req) => {
  const q = req.query as { templateId?: string; limit?: string };
  return listRuns(Number(q.limit ?? 100), q.templateId ? Number(q.templateId) : undefined);
});

/** Accepts an ISO timestamp or YYYY-MM-DD (UTC day start). */
function isoParam(v: string | undefined, name: string): string | undefined {
  if (!v) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Bad ${name} date: ${v}`);
  return d.toISOString();
}

app.get('/api/runs/search', async (req) => {
  const q = req.query as Record<string, string | undefined>;
  return searchRuns({
    from: isoParam(q.from, 'from'),
    to: isoParam(q.to, 'to'),
    status: q.status ? q.status.split(',').filter(Boolean) : undefined,
    templateId: q.templateId ? Number(q.templateId) : undefined,
    source: q.source === 'mcp' || q.source === 'ui' ? q.source : undefined,
    q: q.q,
    limit: q.limit ? Number(q.limit) : undefined,
    offset: q.offset ? Number(q.offset) : undefined,
  });
});

app.post('/api/runs', async (req) => {
  const b = req.body as {
    mode?: 'generate' | 'replay';
    templateId?: number;
    name?: string;
    baseUrl?: string;
    instruction?: string;
    variables?: Variable[];
  };
  const template = b.templateId ? getTemplate(b.templateId) : undefined;
  if (b.templateId && !template) throw new HttpError(404, 'Template not found');
  const baseUrl = (b.baseUrl || template?.base_url || '').trim();
  if (!/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'Base URL must start with http:// or https://');
  const mode = b.mode ?? (template?.spec ? 'replay' : 'generate');
  if (mode === 'replay' && !template?.spec) throw new HttpError(400, 'Replay needs a template with a saved spec');
  const instruction = b.instruction ?? template?.instruction ?? '';
  if (mode === 'generate' && !instruction.trim() && !template) throw new HttpError(400, 'Describe the test scope');
  const run = createRun({
    template_id: template?.id ?? null,
    name: (b.name || template?.name || 'Untitled flow').trim(),
    mode,
    base_url: baseUrl,
    instruction,
    variables: (b.variables ?? []).filter((v) => v.key?.trim()),
    source: sourceOf(req),
  });
  rememberBaseUrl(baseUrl);
  enqueue(run.id);
  return run;
});

app.get('/api/runs/:id', async (req) => {
  const run = mustRun(idParam(req.params));
  const dir = runDir(run.id);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
  return {
    run,
    result: readResult(run.id),
    spec: read('flow.spec.ts'),
    agentSummary: read('agent-summary.md'),
    hasReport: existsSync(join(dir, 'report', 'index.html')),
    template: run.template_id ? getTemplate(run.template_id) ?? null : null,
    queue: queueState(),
  };
});

app.get('/api/runs/:id/log', async (req, reply) => {
  const f = join(runDir(idParam(req.params)), 'run.log');
  reply.type('text/plain; charset=utf-8');
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
});

app.get('/api/runs/:id/events', (req, reply) => {
  const id = idParam(req.params);
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (e: RunEvent) => {
    if (e.runId === id) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  events.on('event', send);
  req.raw.on('close', () => {
    clearInterval(ping);
    events.off('event', send);
  });
});

app.post('/api/runs/:id/cancel', async (req) => ({ ok: cancel(idParam(req.params)) }));

app.post('/api/runs/:id/rerun', async (req) => {
  const prev = mustRun(idParam(req.params));
  const template = prev.template_id ? getTemplate(prev.template_id) : undefined;
  const run = createRun({
    template_id: prev.template_id,
    name: prev.name,
    // A template with a spec replays; a one-off AI run is generated again.
    mode: template?.spec ? 'replay' : 'generate',
    base_url: (req.body as { baseUrl?: string } | undefined)?.baseUrl || prev.base_url,
    instruction: prev.instruction,
    variables: prev.variables,
    source: sourceOf(req),
  });
  enqueue(run.id);
  return run;
});

app.delete('/api/runs/:id', async (req) => {
  const id = idParam(req.params);
  if (isActive(id)) throw new HttpError(409, 'Cancel the run first');
  cancel(id);
  deleteRun(id);
  rmSync(runDir(id), { recursive: true, force: true });
  return { ok: true };
});

app.post('/api/runs/:id/save-template', async (req) => {
  const run = mustRun(idParam(req.params));
  const b = (req.body ?? {}) as { name?: string; description?: string; templateId?: number };
  const specFile = join(runDir(run.id), 'flow.spec.ts');
  if (!existsSync(specFile)) throw new HttpError(400, 'This run has no spec');
  const spec = readFileSync(specFile, 'utf8');
  const target = b.templateId ? getTemplate(b.templateId) : undefined;
  const saved = saveTemplate({
    id: target?.id,
    name: (b.name || target?.name || run.name).trim(),
    description: b.description ?? target?.description ?? '',
    instruction: run.instruction,
    base_url: target?.base_url || run.base_url,
    spec,
    variables: target?.variables ?? run.variables.filter((v) => !v.secret),
  });
  if (!run.template_id) updateRun(run.id, { template_id: saved.id });
  return saved;
});

// ---- slack ----------------------------------------------------------------

const icon: Record<string, string> = { passed: '✅', flaky: '⚠️', failed: '❌', timedOut: '⏱️', skipped: '⏭️', interrupted: '⛔' };
const fmtDuration = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/** First line of a Playwright error plus its Expected/Received lines. */
function briefError(error: string): string {
  const lines = error.split('\n').map((l) => l.trim()).filter(Boolean);
  const detail = lines.filter((l) => /^(Expected|Received)/.test(l)).slice(0, 2);
  return [lines[0] ?? '', ...detail].join(' · ').slice(0, 300);
}

function draftText(run: Run, result: RunResult | null): string {
  const s = run.summary;
  const head = run.status === 'passed' ? '✅ Passed' : run.status === 'failed' ? '❌ Failed' : `⚠️ ${run.status}`;
  const lines = [`*QA flow: ${run.name}* — ${head}`, `Target: ${run.base_url}`];
  if (s) lines.push(`Result: *${s.passed}/${s.total} passed*${s.failed ? `, ${s.failed} failed` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''} · ${fmtDuration(s.durationMs)}`);
  if (run.instruction.trim()) lines.push(`Scope: ${run.instruction.trim().split('\n')[0].slice(0, 280)}`);
  if (run.tokens) lines.push(`AI: ${run.tokens.total.toLocaleString('en-US')} tokens${run.cost_usd != null ? ` (~$${run.cost_usd.toFixed(2)})` : ''}`);
  if (result?.tests.length) {
    lines.push('');
    for (const t of result.tests) {
      const failed = t.steps.find((st) => st.status === 'failed');
      const why = t.status === 'failed' || t.status === 'timedOut' ? ` — ${failed ? `step "${failed.title}": ` : ''}${briefError(failed?.error ?? t.error ?? '')}` : '';
      lines.push(`${icon[t.status] ?? '•'} ${t.title} (${t.steps.length} steps)${why}`);
    }
  }
  if (run.error) lines.push('', `Error: ${run.error.slice(0, 300)}`);
  lines.push('', 'Screenshots below 👇');
  return lines.join('\n');
}

function draftImages(result: RunResult | null) {
  const all = (result?.tests ?? []).flatMap((t) =>
    t.steps
      .filter((st) => st.screenshot)
      .map((st, i, arr) => ({
        path: st.screenshot!,
        title: `${t.title} › ${String(st.index).padStart(2, '0')} ${st.title}${st.status === 'failed' ? ' (FAILED)' : ''}`,
        step: `${st.index}. ${st.title}`,
        test: t.title,
        status: st.status,
        // Default pick: every step when small, otherwise failures and each test's last step.
        important: st.status === 'failed' || i === arr.length - 1,
      })),
  );
  const pickAll = all.length <= 10;
  return all.map((img) => ({ ...img, selected: pickAll || img.important }));
}

app.get('/api/runs/:id/slack-draft', async (req) => {
  const run = mustRun(idParam(req.params));
  const result = readResult(run.id);
  const s = getSettings();
  return { text: draftText(run, result), images: draftImages(result), channel: s.slackChannel, tokenSet: !!s.slackToken };
});

app.post('/api/runs/:id/slack', async (req) => {
  const run = mustRun(idParam(req.params));
  const b = req.body as { channel?: string; thread?: string; text: string; images?: string[] };
  const settings = getSettings();
  if (!settings.slackToken) throw new HttpError(400, 'Add a Slack token in Settings first');
  const channelInput = (b.channel || settings.slackChannel || '').trim();
  if (!channelInput && !b.thread) throw new HttpError(400, 'Choose a channel or paste a thread link');
  const { channel, threadTs } = await resolveTarget(settings.slackToken, channelInput || b.thread!, b.thread);
  const result = readResult(run.id);
  const titles = new Map(draftImages(result).map((i) => [i.path, i.title]));
  const dir = runDir(run.id);
  const images = (b.images ?? []).map((p) => {
    const abs = resolve(dir, p);
    if (!abs.startsWith(dir + '/') || !existsSync(abs)) throw new HttpError(400, `Unknown screenshot ${p}`);
    return { path: abs, title: titles.get(p) ?? p };
  });
  const posted = await postReport(settings.slackToken, channel, threadTs, b.text, images);
  updateRun(run.id, { slack: [...run.slack, { ...posted, at: now() }] });
  return posted;
});

// ---- dashboard --------------------------------------------------------------

app.get('/api/dashboard', async () => {
  const runs = listRuns(200);
  const finished = runs.filter((r) => ['passed', 'failed'].includes(r.status));
  const dayAgo = Date.now() - 86_400_000;
  return {
    templates: listTemplates().length,
    runs24h: runs.filter((r) => Date.parse(r.created_at) > dayAgo).length,
    passRate: finished.length ? Math.round((finished.filter((r) => r.status === 'passed').length / finished.length) * 100) : null,
    costUsd: runs.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    usage: {
      today: usageSince(new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
      last30d: usageSince(new Date(Date.now() - 30 * 86_400_000).toISOString()),
      allTime: usageSince(),
    },
    recent: runs.slice(0, 15),
    queue: queueState(),
    scheduler: schedulerState(),
  };
});

app.get('/api/scheduler', async () => schedulerState());

registerMcp(app, PORT);

const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;
app.get('/api/mcp/status', async () => mcpStatus(MCP_URL));
app.post('/api/mcp/install', async () => mcpInstall(MCP_URL));
app.post('/api/mcp/uninstall', async () => mcpUninstall(MCP_URL));

// ---- static -----------------------------------------------------------------

// Run artifacts: screenshots, the Playwright HTML report, specs.
await app.register(fastifyStatic, { root: RUNS_DIR, prefix: '/files/', decorateReply: false });

const WEB = join(ROOT, 'dist');
if (existsSync(WEB)) {
  await app.register(fastifyStatic, { root: WEB, prefix: '/', wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/files/') || req.url.startsWith('/mcp')) return reply.status(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

await app.listen({ port: PORT, host: HOST });
console.log(`qa-flow on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${existsSync(WEB) ? '' : '  (API only: run `pnpm dev` for the UI)'}  ·  MCP: http://127.0.0.1:${PORT}/mcp`);
