// The test library: the knowledge pack's cases/ folder (one Markdown file per case, in
// cases/<module>/<feature>/<code>.md), browsed read-only as Module → Feature → test case, searched
// with FTS5, and turned into a generate-run instruction. Git is the master: the pack is what gets
// synced, and this file only ever reads it (probe-coder design-log/062).
//
// The files are not read per request. They are indexed into data/library-index.db, which nothing
// else depends on: delete it and the next request rebuilds it. The stamp is a stat walk of cases/,
// not the pack's HEAD, so a local uncommitted edit shows up too and no git is needed here; 4,000
// stats take a few milliseconds and are memoized for a moment. What qa-flow adds lives in its own
// DB: `library_specs`, each case's latest passing spec kept as a template (saveLibrarySpecs).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, db as qaDb, deleteTemplate, getSettings, listTemplates, now, saveTemplate, type Run } from './db.ts';
import { resolveKnowledgeDir } from './knowledge.ts';
import type { RunResult } from './runner.ts';

/** Bump when the index shape or the parser changes, so old indexes rebuild. */
const INDEX_VERSION = 1;
const SCAN_TTL_MS = 5000;

/** cases/ of the configured pack; null when there is no pack or it has no cases. */
function casesDir(): string | null {
  const pack = resolveKnowledgeDir(getSettings().knowledgeDir);
  const dir = pack && join(pack, 'cases');
  return dir && existsSync(dir) ? dir : null;
}

// ---- reading the files ------------------------------------------------------

type Frontmatter = Record<string, string>;

function splitFile(text: string): { fm: Frontmatter; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fm: Frontmatter = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: m[2] };
}

const unquote = (v = '') => {
  if (!v.startsWith('"')) return v;
  try {
    return String(JSON.parse(v));
  } catch {
    return v;
  }
};
const listOf = (v = '') => v.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);

export type LibraryStep = { action: string; expected: string };

/** `# <code> — <title>`, `Pre: …`, then `1. <action> → <expected>`; a stray line continues the last step. */
function parseBody(body: string): { title: string; precondition: string | null; steps: LibraryStep[] } {
  let title = '';
  let precondition: string | null = null;
  const steps: LibraryStep[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const step = /^\d+\.\s+(.*)$/.exec(line);
    if (line.startsWith('# ')) title = line.replace(/^# \S+\s+—\s+/, '').replace(/^# /, '');
    else if (line.startsWith('Pre: ')) precondition = line.slice(5);
    else if (step) {
      // An action can hold an arrow of its own (14 of ~10,500 imported steps): nothing is lost either way.
      const i = step[1].indexOf(' → ');
      steps.push(i < 0 ? { action: step[1], expected: '' } : { action: step[1].slice(0, i), expected: step[1].slice(i + 3) });
    } else if (steps.length) steps[steps.length - 1].expected = `${steps[steps.length - 1].expected} ${line}`.trim();
  }
  return { title, precondition, steps };
}

type Scan = { dir: string; stamp: string; files: number; newest: number };
let lastScan: { at: number; scan: Scan } | null = null;

const subdirs = (dir: string) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
const caseFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_feature.md').sort();

function scan(dir: string): Scan {
  if (lastScan && lastScan.scan.dir === dir && Date.now() - lastScan.at < SCAN_TTL_MS) return lastScan.scan;
  let files = 0;
  let size = 0;
  let newest = 0;
  for (const m of subdirs(dir))
    for (const f of subdirs(join(dir, m)))
      for (const name of readdirSync(join(dir, m, f))) {
        const st = statSync(join(dir, m, f, name));
        files++;
        size += st.size;
        newest = Math.max(newest, st.mtimeMs);
      }
  const out = { dir, stamp: `${INDEX_VERSION}|${dir}|${files}|${size}|${newest}`, files, newest };
  lastScan = { at: Date.now(), scan: out };
  return out;
}

// ---- the index --------------------------------------------------------------

let handle: DatabaseSync | null = null;

function build(d: DatabaseSync, dir: string, stamp: string) {
  d.exec('BEGIN');
  try {
    d.exec(`
      DROP TABLE IF EXISTS features; DROP TABLE IF EXISTS cases; DROP TABLE IF EXISTS tc_fts;
      CREATE TABLE features (id TEXT PRIMARY KEY, module TEXT NOT NULL, module_name TEXT NOT NULL, name TEXT NOT NULL, flow TEXT);
      CREATE TABLE cases (code TEXT PRIMARY KEY, feature_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, surface TEXT NOT NULL,
        priority TEXT NOT NULL, test_type TEXT NOT NULL, roles TEXT NOT NULL, platforms TEXT NOT NULL, tags TEXT NOT NULL, source TEXT NOT NULL,
        legacy TEXT NOT NULL, last_run TEXT, precondition TEXT, steps TEXT NOT NULL);
      CREATE INDEX cases_feature ON cases(feature_id);
      CREATE VIRTUAL TABLE tc_fts USING fts5(code, title, body, place, tokenize = 'unicode61');
    `);
    const addFeature = d.prepare('INSERT INTO features VALUES (?, ?, ?, ?, ?)');
    const addCase = d.prepare('INSERT OR REPLACE INTO cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const addText = d.prepare('INSERT INTO tc_fts (code, title, body, place) VALUES (?, ?, ?, ?)');
    for (const m of subdirs(dir))
      for (const f of subdirs(join(dir, m))) {
        const path = join(dir, m, f);
        const meta = existsSync(join(path, '_feature.md')) ? splitFile(readFileSync(join(path, '_feature.md'), 'utf8'))?.fm : undefined;
        const moduleName = unquote(meta?.module) || m;
        const name = unquote(meta?.name) || f;
        const id = `${m}/${f}`;
        addFeature.run(id, m, moduleName, name, meta?.flow || null);
        for (const file of caseFiles(path)) {
          const parsed = splitFile(readFileSync(join(path, file), 'utf8'));
          if (!parsed?.fm.code) continue;
          const { fm, body } = parsed;
          const { title, precondition, steps } = parseBody(body);
          const tags = unquote(fm.tags);
          addCase.run(fm.code, id, title, fm.status ?? '', fm.surface ?? '', fm.priority ?? '', fm.type ?? '', JSON.stringify(listOf(fm.roles)),
            JSON.stringify(listOf(fm.platforms)), tags, fm.source ?? '', JSON.stringify(listOf(fm.legacy)), fm.lastRun ?? null, precondition, JSON.stringify(steps));
          addText.run(fm.code, title, [precondition, ...steps.flatMap((s) => [s.action, s.expected]), tags].filter(Boolean).join(' '), `${moduleName} ${name}`);
        }
      }
    d.prepare(`INSERT INTO meta (k, v) VALUES ('stamp', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(stamp);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** The index, current with the pack; null when there is no library. Every reader starts here. */
function library(): { d: DatabaseSync; scan: Scan } | null {
  const dir = casesDir();
  if (!dir) return null;
  const s = scan(dir);
  if (!s.files) return null;
  if (!handle) {
    handle = new DatabaseSync(join(DATA_DIR, 'library-index.db'));
    handle.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  }
  const have = (handle.prepare(`SELECT v FROM meta WHERE k = 'stamp'`).get() as { v: string } | undefined)?.v;
  if (have !== s.stamp) build(handle, dir, s.stamp);
  return { d: handle, scan: s };
}

/** Whether a library is there, for the routes that need one. */
export const hasLibrary = () => library() !== null;

export type LibraryStatus = { path: string; modules: number; features: number; tcs: number; active: number; updatedAt: string };

export function libraryStatus(): LibraryStatus | null {
  const lib = library();
  if (!lib) return null;
  const r = lib.d
    .prepare(
      `SELECT COUNT(DISTINCT f.module) AS modules, COUNT(DISTINCT c.feature_id) AS features, COUNT(*) AS tcs, SUM(c.status = 'ACTIVE') AS active
         FROM cases c JOIN features f ON f.id = c.feature_id`,
    )
    .get() as { modules: number; features: number; tcs: number; active: number | null };
  return { path: lib.scan.dir, ...r, active: r.active ?? 0, updatedAt: new Date(lib.scan.newest).toISOString() };
}

export type LibraryFeature = { id: string; name: string; flowRef: string | null; tcs: number; active: number };
export type LibraryModule = { id: string; key: string; name: string; tcs: number; active: number; features: LibraryFeature[] };

export function libraryTree(): LibraryModule[] {
  const lib = library();
  if (!lib) return [];
  const rows = lib.d
    .prepare(
      `SELECT f.id, f.name, f.flow AS flowRef, f.module, f.module_name AS moduleName, COUNT(c.code) AS tcs, COALESCE(SUM(c.status = 'ACTIVE'), 0) AS active
         FROM features f JOIN cases c ON c.feature_id = f.id GROUP BY f.id ORDER BY f.module_name, f.name`,
    )
    .all() as (LibraryFeature & { module: string; moduleName: string })[];
  const mods = new Map<string, LibraryModule>();
  for (const { module, moduleName, ...f } of rows) {
    const m = mods.get(module) ?? mods.set(module, { id: module, key: module, name: moduleName, tcs: 0, active: 0, features: [] }).get(module)!;
    m.features.push(f);
    m.tcs += f.tcs;
    m.active += f.active;
  }
  return [...mods.values()];
}

export type LastResult = { status: string; at: string | null; run: string };
export type LibraryTc = {
  code: string;
  title: string;
  status: string;
  surface: string;
  priority: string;
  testType: string;
  roles: string[];
  module: string;
  feature: string;
  featureId: string;
  last: LastResult | null;
  /** The latest passing qa-flow spec of this case, kept as a template (replays with no AI). */
  spec: LibrarySpec | null;
};

type CaseRow = {
  code: string; title: string; status: string; surface: string; priority: string; test_type: string; roles: string; platforms: string;
  tags: string; source: string; legacy: string; last_run: string | null; precondition: string | null; steps: string;
  feature_id: string; feature: string; module: string; flow: string | null;
};
const CASE_SELECT = `SELECT c.*, f.name AS feature, f.module_name AS module, f.flow FROM cases c JOIN features f ON f.id = c.feature_id`;

/** `lastRun: PASS 2026-10-30 STAGING` */
function lastResult(v: string | null): LastResult | null {
  const [status, at, run] = (v ?? '').split(/\s+/);
  return status ? { status, at: at ?? null, run: run ?? '' } : null;
}

function toTc(rows: CaseRow[]): LibraryTc[] {
  const specs = librarySpecs(rows.map((r) => r.code));
  return rows.map((r) => ({
    code: r.code,
    title: r.title,
    status: r.status,
    surface: r.surface,
    priority: r.priority,
    testType: r.test_type,
    roles: JSON.parse(r.roles) as string[],
    module: r.module,
    feature: r.feature,
    featureId: r.feature_id,
    last: lastResult(r.last_run),
    spec: specs.get(r.code) ?? null,
  }));
}

export function featureCases(featureId: string): LibraryTc[] {
  const lib = library();
  return lib ? toTc(lib.d.prepare(`${CASE_SELECT} WHERE c.feature_id = ? ORDER BY c.code`).all(featureId) as CaseRow[]) : [];
}

export type LibraryTcDetail = LibraryTc & {
  precondition: string | null;
  steps: LibraryStep[];
  platforms: string[];
  tags: string;
  flowRef: string | null;
  version: number;
  sources: { kind: string; ref: string }[];
  qaFlowRuns: { id: number; name: string; status: string; created_at: string }[];
};

export function caseDetail(code: string): LibraryTcDetail | null {
  const row = library()?.d.prepare(`${CASE_SELECT} WHERE c.code = ?`).get(code) as CaseRow | undefined;
  if (!row) return null;
  return {
    ...toTc([row])[0],
    precondition: row.precondition,
    steps: JSON.parse(row.steps) as LibraryStep[],
    platforms: JSON.parse(row.platforms) as string[],
    tags: row.tags,
    flowRef: row.flow,
    version: Number(/ v(\d+)$/.exec(row.source)?.[1] ?? 1),
    sources: [
      ...(row.source ? [{ kind: 'SOURCE', ref: row.source }] : []),
      ...(JSON.parse(row.legacy) as string[]).map((ref) => ({ kind: 'LEGACY_CODE', ref })),
    ],
    // Our own runs whose scope names the code (built by libraryInstruction, or typed by hand).
    qaFlowRuns: qaDb
      .prepare(`SELECT id, name, status, created_at FROM runs WHERE instruction LIKE ? ORDER BY id DESC LIMIT 5`)
      .all(`%${code}%`) as LibraryTcDetail['qaFlowRuns'],
  };
}

// ---- search ---------------------------------------------------------------

/** Every word must match (prefix), title and code weigh most. A bare code finds that case. */
function ftsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export type SearchFilters = { status?: string; surface?: string; module?: string; limit?: number };

export function searchCases(q: string, f: SearchFilters = {}): LibraryTc[] {
  const match = ftsQuery(q);
  const lib = library();
  if (!match || !lib) return [];
  const codes = (lib.d.prepare(`SELECT code FROM tc_fts WHERE tc_fts MATCH ? ORDER BY bm25(tc_fts, 8, 4, 1, 2) LIMIT 400`).all(match) as { code: string }[]).map((r) => r.code);
  if (!codes.length) return [];
  const rank = new Map(codes.map((c, i) => [c, i]));
  const where = [`c.code IN (${codes.map(() => '?').join(',')})`];
  const args: string[] = [...codes];
  if (f.status) (where.push('c.status = ?'), args.push(f.status));
  if (f.surface) (where.push('c.surface = ?'), args.push(f.surface));
  if (f.module) (where.push('f.module = ?'), args.push(f.module));
  const rows = (lib.d.prepare(`${CASE_SELECT} WHERE ${where.join(' AND ')}`).all(...args) as CaseRow[])
    .sort((a, b) => rank.get(a.code)! - rank.get(b.code)!)
    .slice(0, Math.min(f.limit ?? 100, 200));
  return toTc(rows);
}

// ---- run instruction --------------------------------------------------------

/**
 * A generate-run scope from library cases: one Playwright test per case, titled with its code so
 * the result maps back to it. Steps and expected results are the case's own words.
 */
export function libraryInstruction(codes: string[]): { name: string; instruction: string; missing: string[] } {
  const cases = codes.map((c) => ({ code: c, tc: caseDetail(c) }));
  const found = cases.flatMap((c) => (c.tc ? [c.tc] : []));
  const missing = cases.filter((c) => !c.tc).map((c) => c.code);
  const features = [...new Set(found.map((t) => `${t.module} › ${t.feature}`))];
  const name =
    found.length === 1
      ? `${found[0].code} — ${found[0].title}`
      : `Library: ${features.length === 1 ? features[0] : `${found.length} cases`} (${found.map((t) => t.code).join(', ')})`;
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
    `Run these ${found.length} test case(s) from the QA team's test library.`,
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
/** The library codes a text names (a test title, a scope). */
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
  const lib = library();
  if (!lib) return null;
  const seen = new Map<string, { ok: boolean; title: string }>();
  // A test replayed from a library spec in this run (design-log/066) is not in flow.spec.ts.
  for (const t of result.tests.filter((x) => !x.file.endsWith('.lib.spec.ts')))
    for (const code of codesIn(t.title)) {
      const prev = seen.get(code);
      seen.set(code, { ok: (prev?.ok ?? true) && t.status === 'passed', title: prev?.title ?? t.title });
    }
  const candidates = [...seen].filter(([, v]) => v.ok).map(([c]) => c);
  if (!candidates.length) return null;
  const q = lib.d.prepare('SELECT title FROM cases WHERE code = ?');
  const titles = new Map(candidates.flatMap((c) => {
    const r = q.get(c) as { title: string } | undefined;
    return r ? [[c, r.title] as const] : [];
  }));
  const codes = candidates.filter((c) => titles.has(c));
  if (!codes.length) return null;

  const name =
    codes.length === 1
      ? `${codes[0]} — ${titles.get(codes[0])}`
      : `Library: ${codes.length} cases (${codes.slice(0, 4).join(', ')}${codes.length > 4 ? ', …' : ''})`;
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
