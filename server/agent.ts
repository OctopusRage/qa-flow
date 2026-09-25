import { query } from '@anthropic-ai/claude-agent-sdk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings, type Run, type TokenUsage, type Variable } from './db.ts';

const SYSTEM = `You are a senior QA automation engineer. You turn a plain-language test scope into a
reliable Playwright end-to-end test and prove it by running it against the live app.

Working folder layout (your cwd):
- qa.ts                harness. Import from it: import { test, expect, v, vars } from './qa';
- playwright.config.ts baseURL, timeouts, reporters. Do not edit.
- ./pw                 the Playwright CLI. The ONLY way to run tests: ./pw test <file>
- flow.spec.ts         YOUR DELIVERABLE.
- scratch/             throwaway exploration specs (deleted after the run).

Rules for flow.spec.ts:
1. Every test uses the qa fixture: test('name', async ({ page, qa, browser }) => { ... }).
   Wrap EVERY user-visible action or check in await qa.step('Plain-English step title', async () => { ... }).
   The harness screenshots the active page after each step, pass or fail; those screenshots are the
   report, so steps should be small and titled like a manual test case ("Log in as the admin",
   "Open Broadcast settings", "Approve button is hidden for the maker").
2. A second user/session: const ctx = await browser.newContext(); const p2 = await ctx.newPage();
   then qa.use(p2) or qa.step(title, fn, { page: p2 }) so screenshots come from the right page.
3. The base URL may carry a path prefix (e.g. https://host/webui/). Navigate with RELATIVE paths and
   no leading slash: page.goto('login'), page.goto('') for the root. Never hard-code the host.
4. Credentials and other inputs come from variables: v('ADMIN_EMAIL'). Never hard-code them.
   Secret values are withheld from you on purpose: do not try to read or print them (no env dumps,
   no echo). Only reference them through v().
5. Prefer getByRole / getByLabel / getByText / getByTestId locators. Use expect(...) with web-first
   assertions; avoid fixed waits. Keep tests independent where the scope allows.
6. Assert what the scope asks for. If the app really misbehaves, keep the assertion honest (let that
   test fail with a clear message) instead of weakening it, and report it as a finding.
7. Stay inside the scope. No destructive actions (deleting data, changing settings) unless the scope
   asks for them, and restore anything you change.

How to work:
- Explore with small specs in scratch/ (they may import from '../qa'), run: ./pw test scratch/x.spec.ts
  Inside them call await qa.dump('label') to save an accessibility snapshot (scratch/dumps/label.yml)
  and a screenshot (scratch/dumps/label.png); read those files to learn the real UI and selectors.
- Write flow.spec.ts, run ./pw test flow.spec.ts, fix, repeat until it passes (or fails only on a
  genuine app bug you will report).
- Finish with a short markdown summary: the tests and their steps, what passed, and any app bugs or
  flaky areas found. No preamble.`;

function describeVariables(vars: Variable[]): string {
  if (!vars.length) return '(none defined)';
  return vars
    .map((v) => `- ${v.key}: ${v.secret ? '(secret, use v() only)' : JSON.stringify(v.value)}`)
    .join('\n');
}

function buildPrompt(run: Run, variables: Variable[], existingSpec: string): string {
  const parts = [
    `Target base URL: ${run.base_url}`,
    `Flow name: ${run.name}`,
    `## Test scope\n${run.instruction || '(no extra instruction: cover the main happy path of the flow name)'}`,
    `## Variables available through v('KEY')\n${describeVariables(variables)}`,
  ];
  if (existingSpec) {
    parts.push(
      `## Existing flow.spec.ts\nflow.spec.ts already holds the previous version of this flow. Run it first; ` +
        `update it for the scope above and for any UI changes instead of starting over.`,
    );
  }
  parts.push('Deliver a passing flow.spec.ts now.');
  return parts.join('\n\n');
}

/** Running tally from streamed assistant messages; replaced by the result's exact modelUsage. */
function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, models: {} };
}
function withTotal(u: TokenUsage): TokenUsage {
  u.total = u.input + u.output + u.cacheRead + u.cacheWrite;
  return u;
}

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function generateSpec(opts: {
  run: Run;
  dir: string;
  env: NodeJS.ProcessEnv;
  variables: Variable[];
  existingSpec: string;
  abort: AbortController;
  log: (line: string) => void;
  /** Called whenever the token tally changes (live progress). */
  onUsage?: (usage: TokenUsage, costUsd: number | null) => void;
}): Promise<{ costUsd: number | null; tokens: TokenUsage }> {
  const settings = getSettings();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) env[k] = v;
  if (settings.anthropicApiKey) env.ANTHROPIC_API_KEY = settings.anthropicApiKey;

  opts.log(`🤖 Generating the spec with Claude${settings.model ? ` (${settings.model})` : ''}, max ${settings.maxTurns} turns`);
  let costUsd: number | null = null;
  let summary = '';
  const usage = emptyUsage();
  // A streamed message arrives in several frames that share one id and repeat its usage.
  const counted = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();

  const stream = query({
    prompt: buildPrompt(opts.run, opts.variables, opts.existingSpec),
    options: {
      cwd: opts.dir,
      env,
      abortController: opts.abort,
      model: settings.model || undefined,
      maxTurns: settings.maxTurns,
      systemPrompt: SYSTEM,
      settingSources: [],
      // No prompts: anything not listed is denied. Bash is limited to the Playwright wrapper
      // and a few harmless commands so secrets in the environment stay out of the transcript.
      permissionMode: 'dontAsk',
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash(./pw test:*)',
        'Bash(./pw test *)',
        'Bash(ls:*)',
        'Bash(ls *)',
        'Bash(mkdir:*)',
        'Bash(mkdir *)',
        'Bash(rm -rf scratch:*)',
        'Bash(rm -rf scratch*)',
      ],
      disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'Task'],
    },
  });

  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const u = msg.message.usage;
      if (u && msg.message.id) {
        const next = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
        const prev = counted.get(msg.message.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        // Frames of one message report cumulative counts: add only the growth.
        const model = msg.message.model || 'unknown';
        const m = (usage.models[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
        for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
          const delta = Math.max(0, next[k] - prev[k]);
          usage[k] += delta;
          m[k] += delta;
        }
        counted.set(msg.message.id, { input: Math.max(prev.input, next.input), output: Math.max(prev.output, next.output), cacheRead: Math.max(prev.cacheRead, next.cacheRead), cacheWrite: Math.max(prev.cacheWrite, next.cacheWrite) });
        opts.onUsage?.(withTotal(usage), costUsd);
      }
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          opts.log(`🤖 ${block.text.trim()}`);
          summary = block.text.trim();
        } else if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown>;
          const detail = input.command ?? input.file_path ?? input.pattern ?? '';
          opts.log(`→ ${block.name} ${clip(String(detail), 200)}`);
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
          const content = (block as { content?: unknown }).content;
          const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? '').join('\n') : '';
          const tail = text.trim().split('\n').slice(-6).join('\n');
          if (tail) opts.log(`  ${clip(tail, 600).replace(/\n/g, '\n  ')}`);
        }
      }
    } else if (msg.type === 'result') {
      costUsd = msg.total_cost_usd ?? null;
      // modelUsage covers every model call (subagents, compaction): it is the exact figure.
      if (msg.modelUsage && Object.keys(msg.modelUsage).length) {
        const exact = emptyUsage();
        for (const [model, mu] of Object.entries(msg.modelUsage)) {
          const m = { input: mu.inputTokens ?? 0, output: mu.outputTokens ?? 0, cacheRead: mu.cacheReadInputTokens ?? 0, cacheWrite: mu.cacheCreationInputTokens ?? 0, costUsd: mu.costUSD ?? 0 };
          exact.models[model] = m;
          exact.input += m.input;
          exact.output += m.output;
          exact.cacheRead += m.cacheRead;
          exact.cacheWrite += m.cacheWrite;
        }
        Object.assign(usage, withTotal(exact));
      }
      opts.onUsage?.(withTotal(usage), costUsd);
      opts.log(`🤖 Agent finished: ${msg.subtype}, ${msg.num_turns} turns, ${usage.total.toLocaleString('en-US')} tokens (in ${usage.input.toLocaleString('en-US')}, out ${usage.output.toLocaleString('en-US')}, cache read ${usage.cacheRead.toLocaleString('en-US')}, cache write ${usage.cacheWrite.toLocaleString('en-US')})${costUsd != null ? `, ~$${costUsd.toFixed(2)}` : ''}`);
      if (msg.subtype === 'success' && msg.result) summary = msg.result;
      if (msg.subtype !== 'success') opts.log(`⚠ Agent stopped early (${msg.subtype}); verifying whatever flow.spec.ts it left.`);
    }
  }
  if (summary) writeFileSync(join(opts.dir, 'agent-summary.md'), summary);
  return { costUsd, tokens: withTotal(usage) };
}
