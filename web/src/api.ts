import { ref } from 'vue';

export type Variable = { key: string; value: string; secret?: boolean; isSet?: boolean };
export type RunStatus = 'queued' | 'generating' | 'running' | 'passed' | 'failed' | 'error' | 'canceled';
export type RunSummary = { total: number; passed: number; failed: number; skipped: number; flaky: number; durationMs: number };
export type Run = {
  id: number;
  template_id: number | null;
  name: string;
  mode: 'generate' | 'replay';
  base_url: string;
  instruction: string;
  variables: Variable[];
  status: RunStatus;
  summary: RunSummary | null;
  cost_usd: number | null;
  error: string | null;
  slack: { channel: string; ts: string; permalink?: string; at: string }[];
  source: 'ui' | 'mcp';
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};
export type Template = {
  id: number;
  name: string;
  description: string;
  instruction: string;
  base_url: string;
  spec: string;
  variables: Variable[];
  created_at: string;
  updated_at: string;
  lastRun?: Run | null;
  runCount?: number;
  runs?: Run[];
};
export type Step = { testId: string; test: string; index: number; title: string; status: 'passed' | 'failed' | 'info'; error: string | null; durationMs: number; screenshot: string | null; url: string | null };
export type TestResult = { id: string; title: string; status: string; durationMs: number; retries: number; error: string | null; steps: Step[]; finalScreenshot: string | null };
export type RunDetail = {
  run: Run;
  result: { summary: RunSummary; tests: TestResult[]; error?: string } | null;
  spec: string | null;
  agentSummary: string | null;
  hasReport: boolean;
  template: Template | null;
  queue: { active: number | null; queued: number[] };
};
export type Settings = {
  slackToken: string;
  slackTokenHint: string;
  slackChannel: string;
  anthropicApiKey: string;
  anthropicApiKeyHint: string;
  model: string;
  maxTurns: number;
  headless: boolean;
  workers: number;
  testTimeoutSec: number;
  variables: Variable[];
  baseUrls: string[];
};

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

export const fileUrl = (runId: number, path: string) => `/files/${runId}/${path}`;

export const toastText = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string) {
  toastText.value = text;
  clearTimeout(timer);
  timer = setTimeout(() => (toastText.value = ''), 3500);
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function fmtDuration(ms?: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const isLive = (s: RunStatus) => s === 'queued' || s === 'generating' || s === 'running';
