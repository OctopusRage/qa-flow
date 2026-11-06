// Optional test library: a QTM database (the QA team's test-case manager, SQLite via Prisma) browsed
// read-only as Module → Feature → test case, searched with FTS5, and turned into a generate-run
// instruction. qa-flow never writes it: QA edits cases in QTM. What qa-flow adds lives in its own DB:
// `library_specs`, each case's latest passing spec kept as a template (saveLibrarySpecs, after a run).
//
// The file is opened per request, never held: whoever syncs it (probe-coder on the test box) replaces
// it by rename, and a held handle would keep reading the old inode. The search index lives in our own
// data dir and is rebuilt when the file's size/mtime changes (a few thousand rows: well under a second).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DATA_DIR, db as qaDb, deleteTemplate, getSettings, listTemplates, now, saveTemplate, type Run } from './db.ts';
import type { RunResult } from './runner.ts';

const expand = (p: string) => resolve(p.trim().replace(/^~(?=$|\/)/, homedir()));

/** The database path when it looks like a QTM database; null otherwise. */
export function resolveLibraryDb(input: string): string | null {
  if (!input.trim()) return null;
  const path = expand(input);
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  try {
    return withDb(path, (d) => (d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='TestCase'`).get() ? path : null));
  } catch {
    return null;
  }
}

function withDb<T>(path: string, fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

const LIVE = `t.deletedAt IS NULL AND t.archivedAt IS NULL`;

export type LibraryStatus = { path: string; modules: number; features: number; tcs: number; active: number; updatedAt: string };

export function libraryStatus(path: string): LibraryStatus {
  return withDb(path, (d) => {
    const r = d
      .prepare(
        `SELECT COUNT(DISTINCT f.moduleId) AS modules, COUNT(DISTINCT t.featureId) AS features,
                COUNT(*) AS tcs, SUM(t.status = 'ACTIVE') AS active
           FROM "TestCase" t JOIN "Feature" f ON f.id = t.featureId WHERE ${LIVE}`,
      )
      .get() as { modules: number; features: number; tcs: number; active: number | null };
    return { path, ...r, active: r.active ?? 0, updatedAt: statSync(path).mtime.toISOString() };
  });
}

export type LibraryFeature = { id: string; name: string; flowRef: string | null; tcs: number; active: number };
export type LibraryModule = { id: string; key: string; name: string; tcs: number; active: number; features: LibraryFeature[] };

export function libraryTree(path: string): LibraryModule[] {
  return withDb(path, (d) => {
    const mods = d.prepare(`SELECT id, COALESCE(key, '') AS key, name FROM "Module" ORDER BY "order", name`).all() as { id: string; key: string; name: string }[];
    const feats = d
      .prepare(
        `SELECT f.id, f.name, f.moduleId, f.flowRef, COUNT(t.id) AS tcs, COALESCE(SUM(t.status = 'ACTIVE'), 0) AS active
           FROM "Feature" f JOIN "TestCase" t ON t.featureId = f.id AND ${LIVE}
          GROUP BY f.id ORDER BY f."order", f.name`,
      )
      .all() as (LibraryFeature & { moduleId: string })[];
    return mods
      .map((m) => {
        const features = feats.filter((f) => f.moduleId === m.id).map(({ moduleId: _, ...f }) => f);
        return { ...m, tcs: features.reduce((n, f) => n + f.tcs, 0), active: features.reduce((n, f) => n + f.active, 0), features };
      })
      .filter((m) => m.tcs > 0);
  });
}

export type LastResult = { status: string; at: string | null; run: string };
export type LibraryTc = {
  code: string;
  title: string;
  status: string;
  surface: string;
  priority: string;
  testType: string;
  automationStatus: string;
  roles: string[];
  module: string;
  feature: string;
  featureId: string;
  last: LastResult | null;
  /** The latest passing qa-flow spec of this case, kept as a template (replays with no AI). */
  spec: LibrarySpec | null;
};

const TC_COLS = `t.id, t.code, t.title, t.status, t.surface, t.priority, t.testType, t.automationStatus,
                 f.id AS featureId, f.name AS feature, m.name AS module`;
const TC_FROM = `"TestCase" t JOIN "Feature" f ON f.id = t.featureId JOIN "Module" m ON m.id = f.moduleId`;

function decorate(d: DatabaseSync, rows: (Omit<LibraryTc, 'roles' | 'last' | 'spec'> & { id: string })[]): LibraryTc[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const roles = new Map<string, string[]>();
  for (const r of d.prepare(`SELECT testCaseId, role FROM "TestCaseRole" WHERE testCaseId IN (${marks}) ORDER BY role`).all(...ids) as { testCaseId: string; role: string }[])
    (roles.get(r.testCaseId) ?? roles.set(r.testCaseId, []).get(r.testCaseId)!).push(r.role);
  const last = new Map<string, LastResult>();
  for (const r of d
    .prepare(
      `SELECT i.testCaseId, i.status, i.executedAt AS at, r.name AS run FROM "TestRunItem" i JOIN "TestRun" r ON r.id = i.testRunId
        WHERE i.testCaseId IN (${marks}) AND i.status != 'UNTESTED' ORDER BY COALESCE(i.executedAt, i.updatedAt) DESC`,
    )
    .all(...ids) as { testCaseId: string; status: string; at: string | null; run: string }[])
    if (!last.has(r.testCaseId)) last.set(r.testCaseId, { status: r.status, at: r.at, run: r.run });
  const specs = librarySpecs(rows.map((r) => r.code));
  return rows.map(({ id, ...r }) => ({ ...r, roles: roles.get(id) ?? [], last: last.get(id) ?? null, spec: specs.get(r.code) ?? null }));
}

export function featureCases(path: string, featureId: string): LibraryTc[] {
  return withDb(path, (d) =>
    decorate(d, d.prepare(`SELECT ${TC_COLS} FROM ${TC_FROM} WHERE ${LIVE} AND t.featureId = ? ORDER BY t.code`).all(featureId) as never),
  );
}

export type LibraryStep = { action: string; expected: string; kind: string };
export type LibraryTcDetail = LibraryTc & {
  precondition: string | null;
  steps: LibraryStep[];
  platforms: string[];
  tags: string;
  flowRef: string | null;
  version: number;
  updatedAt: string;
  sources: { kind: string; ref: string }[];
  runs: { status: string; at: string | null; run: string; env: string; notes: string | null }[];
  qaFlowRuns: { id: number; name: string; status: string; created_at: string }[];
};

export function caseDetail(path: string, code: string): LibraryTcDetail | null {
  const detail = withDb(path, (d): LibraryTcDetail | null => {
    const row = d
      .prepare(`SELECT ${TC_COLS}, t.precondition, t.steps, t.expectedResult, t.featureTags, t.version, t.updatedAt, f.flowRef FROM ${TC_FROM} WHERE t.code = ? AND t.deletedAt IS NULL`)
      .get(code) as (Record<string, unknown> & { id: string }) | undefined;
    if (!row) return null;
    const [base] = decorate(d, [row as never]);
    let steps = (d.prepare(`SELECT action, expected, kind FROM "TestStep" WHERE testCaseId = ? ORDER BY stepNo`).all(row.id) as LibraryStep[]).map((s) => ({ ...s }));
    if (!steps.length) steps = [{ action: String(row.steps ?? ''), expected: String(row.expectedResult ?? ''), kind: '' }];
    return {
      ...base,
      precondition: (row.precondition as string | null) ?? null,
      steps,
      platforms: (d.prepare(`SELECT platform FROM "TestCasePlatform" WHERE testCaseId = ? ORDER BY platform`).all(row.id) as { platform: string }[]).map((p) => p.platform),
      tags: String(row.featureTags ?? ''),
      flowRef: (row.flowRef as string | null) ?? null,
      version: Number(row.version),
      updatedAt: String(row.updatedAt),
      sources: d.prepare(`SELECT kind, ref FROM "TestCaseSource" WHERE testCaseId = ? ORDER BY createdAt LIMIT 10`).all(row.id) as { kind: string; ref: string }[],
      runs: d
        .prepare(
          `SELECT i.status, i.executedAt AS at, r.name AS run, r.environment AS env, i.notes FROM "TestRunItem" i JOIN "TestRun" r ON r.id = i.testRunId
            WHERE i.testCaseId = ? AND i.status != 'UNTESTED' ORDER BY COALESCE(i.executedAt, i.updatedAt) DESC LIMIT 5`,
        )
        .all(row.id) as LibraryTcDetail['runs'],
      qaFlowRuns: [],
    };
  });
  if (detail) {
    // Our own runs whose scope names the code (built by libraryInstruction, or typed by hand).
    detail.qaFlowRuns = qaDb
      .prepare(`SELECT id, name, status, created_at FROM runs WHERE instruction LIKE ? ORDER BY id DESC LIMIT 5`)
      .all(`%${code}%`) as LibraryTcDetail['qaFlowRuns'];
  }
  return detail;
}

// ---- search ---------------------------------------------------------------

const searchPath = join(DATA_DIR, 'library-search.db');

function searchIndex(path: string): DatabaseSync {
  const st = statSync(path);
  const stamp = `${path}|${st.size}|${st.mtimeMs}`;
  const s = new DatabaseSync(searchPath);
  s.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  const have = (s.prepare(`SELECT v FROM meta WHERE k = 'stamp'`).get() as { v: string } | undefined)?.v;
  if (have !== stamp) {
    const rows = withDb(path, (d) => {
      const steps = new Map<string, string[]>();
      for (const r of d.prepare(`SELECT testCaseId, action, expected FROM "TestStep" ORDER BY testCaseId, stepNo`).all() as { testCaseId: string; action: string; expected: string }[])
        (steps.get(r.testCaseId) ?? steps.set(r.testCaseId, []).get(r.testCaseId)!).push(`${r.action} ${r.expected}`);
      type Src = { id: string; code: string; title: string; precondition: string | null; steps: string; expectedResult: string; featureTags: string; feature: string; module: string };
      return (d.prepare(`SELECT t.id, t.code, t.title, t.precondition, t.steps, t.expectedResult, t.featureTags, f.name AS feature, m.name AS module FROM ${TC_FROM} WHERE t.deletedAt IS NULL`).all() as Src[]).map((r) => ({
        ...r,
        body: [r.precondition, ...(steps.get(r.id) ?? [r.steps, r.expectedResult]), r.featureTags].filter(Boolean).join(' '),
      }));
    });
    s.exec(`DROP TABLE IF EXISTS tc_fts; CREATE VIRTUAL TABLE tc_fts USING fts5(id UNINDEXED, code, title, body, place, tokenize = 'unicode61')`);
    const ins = s.prepare(`INSERT INTO tc_fts (id, code, title, body, place) VALUES (?, ?, ?, ?, ?)`);
    s.exec('BEGIN');
    for (const r of rows) ins.run(r.id, r.code, r.title, r.body, `${r.module} ${r.feature}`);
    s.prepare(`INSERT INTO meta (k, v) VALUES ('stamp', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(stamp);
    s.exec('COMMIT');
  }
  return s;
}

/** Every word must match (prefix), title and code weigh most. A bare code finds that case. */
function ftsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export type SearchFilters = { status?: string; surface?: string; module?: string; limit?: number };

export function searchCases(path: string, q: string, f: SearchFilters = {}): LibraryTc[] {
  const match = ftsQuery(q);
  if (!match) return [];
  const s = searchIndex(path);
  let ids: string[];
  try {
    ids = (s.prepare(`SELECT id FROM tc_fts WHERE tc_fts MATCH ? ORDER BY bm25(tc_fts, 0, 8, 4, 1, 2) LIMIT 400`).all(match) as { id: string }[]).map((r) => r.id);
  } finally {
    s.close();
  }
  if (!ids.length) return [];
  const rank = new Map(ids.map((id, i) => [id, i]));
  return withDb(path, (d) => {
    const where = [LIVE, `t.id IN (${ids.map(() => '?').join(',')})`];
    const args: string[] = [...ids];
    if (f.status) (where.push('t.status = ?'), args.push(f.status));
    if (f.surface) (where.push('t.surface = ?'), args.push(f.surface));
    if (f.module) (where.push('(m.key = ? OR m.id = ?)'), args.push(f.module, f.module));
    const rows = (d.prepare(`SELECT ${TC_COLS} FROM ${TC_FROM} WHERE ${where.join(' AND ')}`).all(...args) as { id: string }[])
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
      .slice(0, Math.min(f.limit ?? 100, 200));
    return decorate(d, rows as never);
  });
}

// ---- run instruction --------------------------------------------------------

/**
 * A generate-run scope from library cases: one Playwright test per case, titled with its code so
 * the result maps back to it. Steps and expected results are the case's own words.
 */
export function libraryInstruction(path: string, codes: string[]): { name: string; instruction: string; missing: string[] } {
  const cases = codes.map((c) => ({ code: c, tc: caseDetail(path, c) }));
  const found = cases.flatMap((c) => (c.tc ? [c.tc] : []));
  const missing = cases.filter((c) => !c.tc).map((c) => c.code);
  const features = [...new Set(found.map((t) => `${t.module} › ${t.feature}`))];
  const name =
    found.length === 1
      ? `${found[0].code} — ${found[0].title}`
      : `QTM: ${features.length === 1 ? features[0] : `${found.length} cases`} (${found.map((t) => t.code).join(', ')})`;
  const blocks = found.map((t) =>
    [
      `### ${t.code} — ${t.title}`,
      `Roles: ${t.roles.join(', ') || 'any'} · Surface: ${t.surface} · ${t.priority} · ${t.testType}`,
      ...(t.precondition ? [`Precondition: ${t.precondition}`] : []),
      'Steps:',
      ...t.steps.map((s, i) => `${i + 1}. ${s.action}${s.expected ? `\n   Expected: ${s.expected}` : ''}`),
    ].join('\n'),
  );
  const instruction = [
    `Run these ${found.length} test case(s) from the QA team's QTM test library.`,
    'Write one Playwright test per case and title each test with its code first, e.g.',
    `"${found[0]?.code ?? 'QTC-XXX-0001'} — <title>", so the result maps back to the case.`,
    "Follow each case's steps; its Expected lines are the assertions. Log in as the role it lists.",
    'If a step cannot be done in this environment, skip that test with the reason rather than inventing a different check.',
    '',
    ...blocks.flatMap((b) => [b, '']),
  ].join('\n');
  return { name: name.slice(0, 160), instruction, missing };
}

// ---- saved specs: library case → template ------------------------------------------------

export type LibrarySpec = { templateId: number; runId: number; testTitle: string; savedAt: string };

const CODE_RE = /\bQTC-[A-Z]+-\d+\b/g;
/** The QTM codes a text names (a test title, a scope). */
export const codesIn = (text: string) => [...new Set(text.match(CODE_RE) ?? [])];

export function librarySpecs(codes: string[]): Map<string, LibrarySpec> {
  const out = new Map<string, LibrarySpec>();
  if (!codes.length) return out;
  const rows = qaDb
    .prepare(`SELECT code, template_id, run_id, test_title, saved_at FROM library_specs WHERE code IN (${codes.map(() => '?').join(',')})`)
    .all(...codes) as { code: string; template_id: number; run_id: number; test_title: string; saved_at: string }[];
  for (const r of rows) out.set(r.code, { templateId: r.template_id, runId: r.run_id, testTitle: r.test_title, savedAt: r.saved_at });
  return out;
}

/**
 * After a generate run: every library case whose test passed gets the run's spec as its current
 * spec, saved as a template. A case counts when its code is in a passing test's title (the Library's
 * scope titles each test with its code; probe-coder's drafts tag reused cases `[QTM <code>]`) and in
 * no failing one, and when the code is a live case in the configured library. One template per run,
 * holding the whole spec; `test_title` lets a replay or a download pick one case out of it
 * (`playwright test -g <code>`). A template no case points at any more is deleted: these are
 * managed here, not by hand. Replays never save (the spec did not change).
 */
export function saveLibrarySpecs(run: Run, result: RunResult, specFile: string): { templateId: number; codes: string[] } | null {
  if (run.mode !== 'generate' || !existsSync(specFile)) return null;
  const path = resolveLibraryDb(getSettings().libraryDb);
  if (!path) return null;
  const seen = new Map<string, { ok: boolean; title: string }>();
  for (const t of result.tests)
    for (const code of codesIn(t.title)) {
      const prev = seen.get(code);
      seen.set(code, { ok: (prev?.ok ?? true) && t.status === 'passed', title: prev?.title ?? t.title });
    }
  const candidates = [...seen].filter(([, v]) => v.ok).map(([c]) => c);
  if (!candidates.length) return null;
  const titles = withDb(path, (d) => {
    const q = d.prepare(`SELECT t.title FROM "TestCase" t WHERE t.code = ? AND ${LIVE}`);
    return new Map(candidates.flatMap((c) => {
      const r = q.get(c) as { title: string } | undefined;
      return r ? [[c, r.title] as const] : [];
    }));
  });
  const codes = candidates.filter((c) => titles.has(c));
  if (!codes.length) return null;

  const name =
    codes.length === 1
      ? `${codes[0]} — ${titles.get(codes[0])}`
      : `QTM: ${codes.length} cases (${codes.slice(0, 4).join(', ')}${codes.length > 4 ? ', …' : ''})`;
  const saved = saveTemplate({
    name: name.slice(0, 200),
    description: `Saved by the test library from run #${run.id}: the latest passing spec of ${codes.join(', ')}. A newer passing run of a case moves it to that run's template.`,
    instruction: run.instruction,
    base_url: run.base_url,
    spec: readFileSync(specFile, 'utf8'),
    variables: run.variables,
  });
  const before = librarySpecs(codes);
  const upsert = qaDb.prepare(
    `INSERT INTO library_specs (code, template_id, run_id, test_title, saved_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET template_id = excluded.template_id, run_id = excluded.run_id, test_title = excluded.test_title, saved_at = excluded.saved_at`,
  );
  const at = now();
  for (const c of codes) upsert.run(c, saved.id, run.id, seen.get(c)!.title, at);
  const still = qaDb.prepare('SELECT 1 FROM library_specs WHERE template_id = ? LIMIT 1');
  for (const old of new Set([...before.values()].map((b) => b.templateId)))
    if (old !== saved.id && !still.get(old)) deleteTemplate(old);
  return { templateId: saved.id, codes };
}

/** A template deleted by hand drops its library links, so no case points at a missing spec. */
export function forgetTemplateSpecs(templateId: number) {
  qaDb.prepare('DELETE FROM library_specs WHERE template_id = ?').run(templateId);
}

/** Which template holds each case's saved spec: probe-coder mirrors this to git (its design-log/062). */
export function librarySpecLinks() {
  return qaDb.prepare('SELECT code, template_id, test_title FROM library_specs ORDER BY code').all() as { code: string; template_id: number; test_title: string }[];
}

/**
 * Rebuild templates and spec links from a pack's specs/ folder after losing this data dir. Skips a
 * template whose name already exists, so running it twice is safe. Secret values are not in git:
 * a restored variable comes back empty, and the base URL is set at replay.
 */
export function restoreSpecs(dir: string): { restored: number; skipped: number } {
  const folder = join(dir, 'specs');
  const out = { restored: 0, skipped: 0 };
  if (!existsSync(folder)) return out;
  const names = new Set(listTemplates().map((t) => t.name));
  const link = qaDb.prepare('INSERT OR IGNORE INTO library_specs (code, template_id, run_id, test_title, saved_at) VALUES (?, ?, 0, ?, ?)');
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.json')).sort()) {
    const side = JSON.parse(readFileSync(join(folder, file), 'utf8')) as {
      name: string;
      description?: string;
      instruction?: string;
      variables?: { key: string; secret?: boolean }[];
      codes?: { code: string; testTitle: string }[];
    };
    if (names.has(side.name)) {
      out.skipped++;
      continue;
    }
    const specPath = join(folder, file.replace(/\.json$/, '.spec.ts'));
    const t = saveTemplate({
      name: side.name,
      description: side.description ?? '',
      instruction: side.instruction ?? '',
      spec: existsSync(specPath) ? readFileSync(specPath, 'utf8') : '',
      variables: (side.variables ?? []).map((v) => ({ key: v.key, value: '', secret: v.secret })),
    });
    for (const c of side.codes ?? []) link.run(c.code, t.id, c.testTitle, now());
    names.add(side.name);
    out.restored++;
  }
  return out;
}
