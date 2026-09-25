import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.QA_FLOW_DATA ?? join(ROOT, 'data');
export const RUNS_DIR = join(DATA_DIR, 'runs');
mkdirSync(RUNS_DIR, { recursive: true });

const dbPath = join(DATA_DIR, 'qa-flow.db');
export const db = new DatabaseSync(dbPath);
// The database holds the Slack token and secret variables: owner-only.
chmodSync(dbPath, 0o600);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instruction TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    spec TEXT NOT NULL DEFAULT '',
    variables TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    base_url TEXT NOT NULL,
    instruction TEXT NOT NULL DEFAULT '',
    variables TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    summary TEXT,
    cost_usd REAL,
    error TEXT,
    slack TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'ui',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
`);

// Columns added after the first release.
const runCols = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name);
if (!runCols.includes('source')) db.exec("ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'ui'");
if (!runCols.includes('tokens')) db.exec('ALTER TABLE runs ADD COLUMN tokens TEXT');

export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** AI token usage of a run: totals plus a per-model split (models: model id → counts + cost). */
export type TokenUsage = TokenCounts & { total: number; models: Record<string, TokenCounts & { costUsd: number }> };

export type Variable = { key: string; value: string; secret?: boolean };

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
};

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
  tokens: TokenUsage | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

function toTemplate(r: Row): Template {
  return { ...(r as Template), variables: JSON.parse(String(r.variables)) };
}

function toRun(r: Row): Run {
  return {
    ...(r as Run),
    variables: JSON.parse(String(r.variables)),
    summary: r.summary ? JSON.parse(String(r.summary)) : null,
    tokens: r.tokens ? JSON.parse(String(r.tokens)) : null,
    slack: JSON.parse(String(r.slack)),
  };
}

// ---- settings -------------------------------------------------------------

export type Settings = {
  slackToken: string;
  slackChannel: string;
  anthropicApiKey: string;
  model: string;
  maxTurns: number;
  headless: boolean;
  workers: number;
  testTimeoutSec: number;
  /** auto: start more runs while CPU/memory allow (up to maxConcurrent); fixed: always maxConcurrent. */
  concurrencyMode: 'auto' | 'fixed';
  maxConcurrent: number;
  /** auto mode keeps at least this much memory free for the rest of the machine. */
  memoryHeadroomMb: number;
  /** auto mode starts no extra run while CPU usage is above this. */
  cpuLimitPercent: number;
  variables: Variable[];
  baseUrls: string[];
};

const DEFAULTS: Settings = {
  slackToken: '',
  slackChannel: '',
  anthropicApiKey: '',
  model: '',
  maxTurns: 80,
  headless: true,
  workers: 1,
  testTimeoutSec: 300,
  concurrencyMode: 'auto',
  maxConcurrent: 4,
  memoryHeadroomMb: 1536,
  cpuLimitPercent: 75,
  variables: [],
  baseUrls: [],
};

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Settings = structuredClone(DEFAULTS);
  for (const { key, value } of rows) {
    if (key in out) (out as Record<string, unknown>)[key] = JSON.parse(value);
  }
  return out;
}

export function saveSettings(patch: Partial<Settings>) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULTS && value !== undefined) stmt.run(key, JSON.stringify(value));
  }
}

export function rememberBaseUrl(url: string) {
  const s = getSettings();
  saveSettings({ baseUrls: [url, ...s.baseUrls.filter((u) => u !== url)].slice(0, 12) });
}

// ---- templates ------------------------------------------------------------

export function listTemplates(): Template[] {
  return (db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as Row[]).map(toTemplate);
}

export function getTemplate(id: number): Template | undefined {
  const r = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Row | undefined;
  return r && toTemplate(r);
}

export function saveTemplate(t: Partial<Template> & { name: string }): Template {
  const ts = now();
  const vars = JSON.stringify(t.variables ?? []);
  if (t.id) {
    db.prepare(
      'UPDATE templates SET name=?, description=?, instruction=?, base_url=?, spec=?, variables=?, updated_at=? WHERE id=?',
    ).run(t.name, t.description ?? '', t.instruction ?? '', t.base_url ?? '', t.spec ?? '', vars, ts, t.id);
    return getTemplate(t.id)!;
  }
  const res = db
    .prepare(
      'INSERT INTO templates (name, description, instruction, base_url, spec, variables, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(t.name, t.description ?? '', t.instruction ?? '', t.base_url ?? '', t.spec ?? '', vars, ts, ts);
  return getTemplate(Number(res.lastInsertRowid))!;
}

export function deleteTemplate(id: number) {
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
}

// ---- runs -----------------------------------------------------------------

export function listRuns(limit = 100, templateId?: number): Run[] {
  const rows = templateId
    ? db.prepare('SELECT * FROM runs WHERE template_id = ? ORDER BY id DESC LIMIT ?').all(templateId, limit)
    : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
  return (rows as Row[]).map(toRun);
}

export type RunQuery = {
  /** ISO timestamps; created_at >= from and < to. */
  from?: string;
  to?: string;
  status?: string[];
  templateId?: number;
  source?: 'ui' | 'mcp';
  q?: string;
  limit?: number;
  offset?: number;
};

/** Filtered, paginated run history plus per-status counts for the whole filter. */
export type UsageTotals = { tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; aiRuns: number };

export function searchRuns(f: RunQuery): { items: Run[]; total: number; counts: Record<string, number>; usage: UsageTotals } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.from) {
    where.push('created_at >= ?');
    args.push(f.from);
  }
  if (f.to) {
    where.push('created_at < ?');
    args.push(f.to);
  }
  if (f.templateId) {
    where.push('template_id = ?');
    args.push(f.templateId);
  }
  if (f.source) {
    where.push('source = ?');
    args.push(f.source);
  }
  if (f.q?.trim()) {
    where.push("(name LIKE ? ESCAPE '\\' OR base_url LIKE ? ESCAPE '\\' OR CAST(id AS TEXT) = ?)");
    const like = `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like, f.q.trim().replace(/^#/, ''));
  }
  const base = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const counts = Object.fromEntries(
    (db.prepare(`SELECT status, COUNT(*) AS n FROM runs ${base} GROUP BY status`).all(...args) as { status: string; n: number }[]).map((r) => [r.status, r.n]),
  );
  // Status narrows the list but the counts above stay per status, for the filter chips.
  const statusFilter = f.status?.length ? `${base ? `${base} AND` : 'WHERE'} status IN (${f.status.map(() => '?').join(',')})` : base;
  const statusArgs = [...args, ...(f.status ?? [])];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM runs ${statusFilter}`).get(...statusArgs) as { n: number }).n;
  const items = (
    db.prepare(`SELECT * FROM runs ${statusFilter} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...statusArgs, Math.min(f.limit ?? 50, 500), f.offset ?? 0) as Row[]
  ).map(toRun);
  return { items, total, counts, usage: usageTotals(statusFilter, statusArgs) };
}

function usageTotals(where: string, args: (string | number)[]): UsageTotals {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(json_extract(tokens, '$.total')), 0) AS tokens,
              COALESCE(SUM(json_extract(tokens, '$.input')), 0) AS input,
              COALESCE(SUM(json_extract(tokens, '$.output')), 0) AS output,
              COALESCE(SUM(json_extract(tokens, '$.cacheRead')), 0) AS cacheRead,
              COALESCE(SUM(json_extract(tokens, '$.cacheWrite')), 0) AS cacheWrite,
              COALESCE(SUM(cost_usd), 0) AS costUsd,
              COUNT(tokens) AS aiRuns
       FROM runs ${where}`,
    )
    .get(...args) as UsageTotals;
  return { ...r };
}

/** AI usage since a timestamp (all runs when omitted). */
export function usageSince(from?: string): UsageTotals {
  return from ? usageTotals('WHERE created_at >= ?', [from]) : usageTotals('', []);
}

export function getRun(id: number): Run | undefined {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
  return r && toRun(r);
}

export function createRun(r: Pick<Run, 'template_id' | 'name' | 'mode' | 'base_url' | 'instruction' | 'variables' | 'source'>): Run {
  const res = db
    .prepare(
      "INSERT INTO runs (template_id, name, mode, base_url, instruction, variables, source, status, created_at) VALUES (?,?,?,?,?,?,?,'queued',?)",
    )
    .run(r.template_id, r.name, r.mode, r.base_url, r.instruction, JSON.stringify(r.variables), r.source, now());
  return getRun(Number(res.lastInsertRowid))!;
}

export function updateRun(id: number, patch: Partial<Omit<Run, 'id'>>) {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = ?`);
    vals.push(v === null || typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v));
  }
  if (cols.length) db.prepare(`UPDATE runs SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function deleteRun(id: number) {
  db.prepare('DELETE FROM runs WHERE id = ?').run(id);
}

// Runs left mid-flight by a crash or restart can never finish.
db.prepare("UPDATE runs SET status = 'error', error = 'Interrupted by a server restart', finished_at = ? WHERE status IN ('queued','generating','running')").run(now());
