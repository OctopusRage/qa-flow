import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { runDir } from './runner.ts';

// MCP over Streamable HTTP at /mcp (stateless: one server per request). Tools call the REST
// routes through app.inject so validation and behaviour match the web UI exactly.

type Json = Record<string, any>;
const LIVE = ['queued', 'generating', 'running'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerMcp(app: FastifyInstance, port: number) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Json> => {
    const res = await app.inject({ method, url, payload: payload as Json | undefined, headers: { 'x-qa-source': 'mcp' } });
    const body = res.body ? JSON.parse(res.body) : {};
    if (res.statusCode >= 400) throw new Error(body.error ?? `HTTP ${res.statusCode}`);
    return body;
  };

  const text = (t: string, structured?: Json) => ({
    content: [{ type: 'text' as const, text: t }],
    ...(structured ? { structuredContent: structured } : {}),
  });
  const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
  const safe =
    <A,>(fn: (args: A) => Promise<ReturnType<typeof text> | { content: unknown[] }>) =>
    async (args: A) => {
      try {
        return (await fn(args)) as any;
      } catch (e) {
        return fail(e);
      }
    };

  const base = `http://127.0.0.1:${port}`;
  const runLink = (id: number) => `${base}/runs/${id}`;

  /** Compact, model-friendly report of a run. */
  async function describeRun(id: number, includeLog = false) {
    const d = await call('GET', `/api/runs/${id}`);
    const r = d.run;
    const lines = [`Run #${r.id} "${r.name}" — ${r.status} (${r.mode}) on ${r.base_url}`, `Open: ${runLink(r.id)}`];
    if (r.summary) lines.push(`Result: ${r.summary.passed}/${r.summary.total} passed, ${r.summary.failed} failed, ${r.summary.skipped} skipped, ${(r.summary.durationMs / 1000).toFixed(1)}s`);
    if (r.cost_usd != null) lines.push(`AI cost: ~$${r.cost_usd.toFixed(2)}`);
    if (r.error) lines.push(`Error: ${r.error}`);
    if (d.template) lines.push(`Template: #${d.template.id} ${d.template.name}`);
    for (const t of d.result?.tests ?? []) {
      lines.push('', `[${t.status}] ${t.title}`);
      for (const s of t.steps) {
        lines.push(`  ${s.index}. ${s.status === 'failed' ? '✖' : '✓'} ${s.title}${s.screenshot ? `  (screenshot: ${s.screenshot})` : ''}`);
        if (s.error) lines.push(`     ${s.error.split('\n').slice(0, 6).join('\n     ')}`);
      }
      if (t.error && !t.steps.some((s: Json) => s.error)) lines.push(`  error: ${t.error.split('\n').slice(0, 6).join(' | ')}`);
    }
    if (d.agentSummary) lines.push('', '--- AI notes ---', d.agentSummary);
    if (includeLog) {
      const log = await app.inject({ method: 'GET', url: `/api/runs/${id}/log` });
      lines.push('', '--- log (last 80 lines) ---', log.body.split('\n').slice(-80).join('\n'));
    }
    return text(lines.join('\n'), {
      run: r,
      tests: (d.result?.tests ?? []).map((t: Json) => ({ title: t.title, status: t.status, steps: t.steps.map((s: Json) => ({ index: s.index, title: s.title, status: s.status, error: s.error, screenshot: s.screenshot })) })),
      url: runLink(r.id),
    });
  }

  async function waitFor(id: number, timeoutSec: number) {
    const until = Date.now() + timeoutSec * 1000;
    while (Date.now() < until) {
      const d = await call('GET', `/api/runs/${id}`);
      if (!LIVE.includes(d.run.status)) return true;
      await sleep(2000);
    }
    return false;
  }

  const varsList = (vars?: Record<string, string>) => Object.entries(vars ?? {}).map(([key, value]) => ({ key, value }));

  function build() {
    const server = new McpServer({ name: 'qa-flow', version: '0.1.0' });

    server.registerTool(
      'list_templates',
      { title: 'List flow templates', description: 'Saved QA flow templates with their default base URL and last run status.', inputSchema: {}, annotations: { readOnlyHint: true } },
      safe(async () => {
        const list = (await call('GET', '/api/templates')) as unknown as Json[];
        if (!list.length) return text('No templates yet. Use start_run with an instruction to generate one.');
        return text(
          list.map((t) => `#${t.id} ${t.name}${t.spec ? '' : ' (no spec yet)'} — ${t.base_url || 'no default URL'} — last: ${t.lastRun ? `${t.lastRun.status} (run #${t.lastRun.id})` : 'never run'}${t.description ? `\n   ${t.description}` : ''}`).join('\n'),
          { templates: list.map(({ id, name, description, base_url, instruction, lastRun, spec }) => ({ id, name, description, base_url, instruction, hasSpec: !!spec, lastRun: lastRun ? { id: lastRun.id, status: lastRun.status } : null })) },
        );
      }),
    );

    server.registerTool(
      'get_template',
      { title: 'Get a template', description: 'A template with its scope, variables and full Playwright spec.', inputSchema: { templateId: z.number().int() }, annotations: { readOnlyHint: true } },
      safe(async ({ templateId }: { templateId: number }) => {
        const t = await call('GET', `/api/templates/${templateId}`);
        return text(
          [`#${t.id} ${t.name}`, `Base URL: ${t.base_url || '—'}`, `Variables: ${t.variables.map((v: Json) => v.key).join(', ') || 'none'}`, '', '## Scope', t.instruction || '—', '', '## flow.spec.ts', t.spec || '(empty)'].join('\n'),
        );
      }),
    );

    server.registerTool(
      'start_run',
      {
        title: 'Start a QA run',
        description:
          'Replay a saved template (fast, no AI cost) or have the AI generate a new Playwright flow from a plain-language scope. ' +
          'Replay: pass templateId. Generate: pass instruction (+ name), or templateId with mode "generate" to update that template\'s spec. ' +
          'Set wait=true to block until it finishes (AI generation can take several minutes) and get the step-by-step result.',
        inputSchema: {
          templateId: z.number().int().optional().describe('Template to replay (or to regenerate with mode="generate")'),
          mode: z.enum(['replay', 'generate']).optional().describe('Default: replay when the template has a spec, otherwise generate'),
          name: z.string().optional().describe('Flow name for a new AI-generated flow'),
          instruction: z.string().optional().describe('Test scope in plain language (for generate)'),
          baseUrl: z.string().optional().describe('Target, e.g. https://qismo-stag4.qiscus.io/webui/ (default: the template\'s)'),
          variables: z.record(z.string(), z.string()).optional().describe('Run-level variable overrides, e.g. {"APP_CODE":"abc"}'),
          wait: z.boolean().optional().describe('Wait for the run to finish (default false)'),
          timeoutSec: z.number().int().min(10).max(1800).optional().describe('Max seconds to wait (default 900)'),
        },
      },
      safe(async (a: { templateId?: number; mode?: 'replay' | 'generate'; name?: string; instruction?: string; baseUrl?: string; variables?: Record<string, string>; wait?: boolean; timeoutSec?: number }) => {
        const run = await call('POST', '/api/runs', { templateId: a.templateId, mode: a.mode, name: a.name, instruction: a.instruction, baseUrl: a.baseUrl, variables: varsList(a.variables) });
        if (!a.wait) return text(`Started run #${run.id} (${run.mode}) on ${run.base_url}. Watch: ${runLink(run.id)}\nUse wait_for_run or get_run with runId ${run.id}.`, { runId: run.id, url: runLink(run.id) });
        const done = await waitFor(run.id, a.timeoutSec ?? 900);
        const report = await describeRun(run.id);
        if (!done) report.content[0].text = `Still running after the wait limit.\n${report.content[0].text}`;
        return report;
      }),
    );

    server.registerTool(
      'wait_for_run',
      { title: 'Wait for a run', description: 'Block until a run finishes (or the timeout passes), then return its step-by-step result.', inputSchema: { runId: z.number().int(), timeoutSec: z.number().int().min(5).max(1800).optional() }, annotations: { readOnlyHint: true } },
      safe(async ({ runId, timeoutSec }: { runId: number; timeoutSec?: number }) => {
        const done = await waitFor(runId, timeoutSec ?? 900);
        const report = await describeRun(runId);
        if (!done) report.content[0].text = `Still running after ${timeoutSec ?? 900}s.\n${report.content[0].text}`;
        return report;
      }),
    );

    server.registerTool(
      'get_run',
      { title: 'Get a run', description: 'Status, per-test steps (with screenshot paths and errors), AI notes; optionally the log tail.', inputSchema: { runId: z.number().int(), includeLog: z.boolean().optional() }, annotations: { readOnlyHint: true } },
      safe(async ({ runId, includeLog }: { runId: number; includeLog?: boolean }) => describeRun(runId, includeLog)),
    );

    server.registerTool(
      'list_runs',
      { title: 'List runs', description: 'Recent runs, newest first.', inputSchema: { templateId: z.number().int().optional(), limit: z.number().int().min(1).max(100).optional() }, annotations: { readOnlyHint: true } },
      safe(async ({ templateId, limit }: { templateId?: number; limit?: number }) => {
        const q = new URLSearchParams({ limit: String(limit ?? 20), ...(templateId ? { templateId: String(templateId) } : {}) });
        const runs = (await call('GET', `/api/runs?${q}`)) as unknown as Json[];
        if (!runs.length) return text('No runs.');
        return text(runs.map((r) => `#${r.id} [${r.status}] ${r.name} — ${r.base_url}${r.summary ? ` — ${r.summary.passed}/${r.summary.total}` : ''} — ${r.created_at}`).join('\n'));
      }),
    );

    server.registerTool(
      'get_screenshot',
      { title: 'Get a step screenshot', description: 'Returns a step screenshot image. Paths come from get_run (e.g. "screenshots/…png").', inputSchema: { runId: z.number().int(), path: z.string() }, annotations: { readOnlyHint: true } },
      safe(async ({ runId, path }: { runId: number; path: string }) => {
        const dir = runDir(runId);
        const abs = resolve(dir, path);
        if (!abs.startsWith(dir + '/') || !existsSync(abs) || !abs.endsWith('.png')) throw new Error(`No screenshot ${path} in run #${runId}`);
        return { content: [{ type: 'image' as const, data: readFileSync(abs).toString('base64'), mimeType: 'image/png' }] };
      }),
    );

    server.registerTool(
      'cancel_run',
      { title: 'Cancel a run', description: 'Cancel a queued or running run.', inputSchema: { runId: z.number().int() } },
      safe(async ({ runId }: { runId: number }) => {
        const r = await call('POST', `/api/runs/${runId}/cancel`, {});
        return text(r.ok ? `Cancel requested for run #${runId}.` : `Run #${runId} is not queued or running.`);
      }),
    );

    server.registerTool(
      'save_run_as_template',
      {
        title: 'Save a run as a template',
        description: "Store an AI-generated run's spec as a new template, or update an existing template (templateId).",
        inputSchema: { runId: z.number().int(), name: z.string().optional(), description: z.string().optional(), templateId: z.number().int().optional() },
      },
      safe(async ({ runId, name, description, templateId }: { runId: number; name?: string; description?: string; templateId?: number }) => {
        const t = await call('POST', `/api/runs/${runId}/save-template`, { name, description, templateId });
        return text(`Saved template #${t.id} "${t.name}". Replay it with start_run {templateId: ${t.id}}.`, { templateId: t.id });
      }),
    );

    server.registerTool(
      'post_run_to_slack',
      {
        title: 'Post a run report to Slack',
        description:
          'Posts the run report with step screenshots using the Slack token from Settings. Target: channel id / #name (default from Settings) or a message link in thread to reply in that thread. ' +
          'text defaults to the generated summary. images: "default" (all steps if ≤10, else failures + last step per test), "all", or "none".',
        inputSchema: {
          runId: z.number().int(),
          channel: z.string().optional(),
          thread: z.string().optional().describe('Slack message link or thread ts'),
          text: z.string().optional(),
          images: z.enum(['default', 'all', 'none']).optional(),
        },
        annotations: { openWorldHint: true },
      },
      safe(async (a: { runId: number; channel?: string; thread?: string; text?: string; images?: 'default' | 'all' | 'none' }) => {
        const draft = await call('GET', `/api/runs/${a.runId}/slack-draft`);
        const pick = a.images ?? 'default';
        const images = pick === 'none' ? [] : (draft.images as Json[]).filter((i) => pick === 'all' || i.selected).map((i) => i.path);
        const posted = await call('POST', `/api/runs/${a.runId}/slack`, { channel: a.channel, thread: a.thread, text: a.text ?? draft.text, images });
        return text(`Posted run #${a.runId} to Slack with ${images.length} screenshot(s).${posted.permalink ? ` ${posted.permalink}` : ''}`, posted);
      }),
    );

    return server;
  }

  // Local-only server: reject browser requests from other origins (DNS rebinding / CSRF).
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  app.post('/mcp', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return reply.status(403).send({ error: 'Origin not allowed' });
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null };
  app.get('/mcp', async (_req, reply) => reply.status(405).send(notAllowed));
  app.delete('/mcp', async (_req, reply) => reply.status(405).send(notAllowed));
}
