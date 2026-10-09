// Optional knowledge pack: per-module flow maps (flows/<module>.md, or a flows/<module>/ folder of
// an _index.md plus one page per UI menu) and UI component-ID maps
// (ui-map/<module>.json), e.g. the knowledge/ folder of a team's QA repo. Read-only here: an AI
// run gets a copy in its folder so the sandboxed agent can read it.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type KnowledgeModule = {
  name: string;
  /** file is the map itself, or the module folder's _index.md; pages lists the folder's other pages. */
  flow?: { file: string; description: string; pages?: string[] };
  uiMap?: { file: string; components: number; verified: number; app?: string; baseRoute?: string };
};
export type KnowledgeSummary = { dir: string; modules: KnowledgeModule[]; references: { file: string; description: string }[] };

const SUBDIRS = ['flows', 'ui-map', 'reference'];
const hasPack = (d: string) => SUBDIRS.some((sub) => existsSync(join(d, sub)));

/** The pack folder itself, or a repo root holding it under knowledge/. Null when neither. */
export function resolveKnowledgeDir(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const dir = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  if (hasPack(dir)) return dir;
  if (hasPack(join(dir, 'knowledge'))) return join(dir, 'knowledge');
  return null;
}

const files = (dir: string, ext: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext) && !f.startsWith('.')).sort() : [];

function frontmatterDescription(text: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  return /^description:\s*"?(.*?)"?\s*$/m.exec(fm)?.[1] ?? '';
}

export function summarizeKnowledge(dir: string): KnowledgeSummary {
  const modules = new Map<string, KnowledgeModule>();
  const mod = (name: string) => modules.get(name) ?? modules.set(name, { name }).get(name)!;
  for (const f of files(join(dir, 'flows'), '.md')) {
    const description = frontmatterDescription(readFileSync(join(dir, 'flows', f), 'utf8'));
    mod(f.slice(0, -3)).flow = { file: `flows/${f}`, description };
  }
  // A module folder: _index.md (frontmatter, overview, a Pages table) and one page per UI menu.
  // Read the index first, then only the pages the scope needs, not the whole module.
  const flowsDir = join(dir, 'flows');
  const folders = existsSync(flowsDir)
    ? readdirSync(flowsDir).filter((d) => !d.startsWith('_') && !d.startsWith('.') && existsSync(join(flowsDir, d, '_index.md'))).sort()
    : [];
  for (const d of folders) {
    const description = frontmatterDescription(readFileSync(join(flowsDir, d, '_index.md'), 'utf8'));
    const pages = files(join(flowsDir, d), '.md').filter((f) => f !== '_index.md').map((f) => f.slice(0, -3));
    mod(d).flow = { file: `flows/${d}/_index.md`, description, pages };
  }
  for (const f of files(join(dir, 'ui-map'), '.json')) {
    try {
      const map = JSON.parse(readFileSync(join(dir, 'ui-map', f), 'utf8'));
      const comps = Object.values(map.components ?? {}) as { unverified?: boolean }[];
      mod(f.slice(0, -5)).uiMap = {
        file: `ui-map/${f}`,
        components: comps.length,
        verified: comps.filter((c) => !c.unverified).length,
        app: map.app,
        baseRoute: map.base_route,
      };
    } catch {
      // A malformed map is skipped rather than failing the run.
    }
  }
  const references = files(join(dir, 'reference'), '.md').map((f) => ({
    file: `reference/${f}`,
    description: frontmatterDescription(readFileSync(join(dir, 'reference', f), 'utf8')),
  }));
  return { dir, modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)), references };
}

function indexMarkdown(s: KnowledgeSummary): string {
  const rows = s.modules.map((m) => {
    const ui = m.uiMap
      ? `${m.uiMap.file} (${m.uiMap.components} ids, ${m.uiMap.verified} live-verified${m.uiMap.baseRoute ? `, ${m.uiMap.baseRoute}` : ''})`
      : '-';
    const pages = m.flow?.pages?.length ? ` · pages: ${m.flow.pages.join(', ')}` : '';
    return `| ${m.name} | ${m.flow ? `${m.flow.file}: ${m.flow.description || '(no description)'}${pages}` : '-'} | ${ui} |`;
  });
  const refs = s.references.map((r) => `- ${r.file}: ${r.description || '(no description)'}`);
  return [
    '# Knowledge index',
    '',
    ...(rows.length ? ['| Module | Flow map | UI map |', '|---|---|---|', ...rows, ''] : []),
    ...(refs.length ? ['Reference:', ...refs, ''] : []),
  ].join('\n');
}

/** Copies the pack into <runDir>/knowledge and returns the index text for the prompt. */
export function stageKnowledge(dir: string, runDir: string): { index: string; modules: number } | null {
  const target = join(runDir, 'knowledge');
  rmSync(target, { recursive: true, force: true });
  const summary = summarizeKnowledge(dir);
  if (!summary.modules.length && !summary.references.length) return null;
  mkdirSync(target, { recursive: true });
  for (const sub of SUBDIRS) {
    const src = join(dir, sub);
    if (!existsSync(src)) continue;
    // Only the reference material: .md and .json, no scripts or other tooling.
    cpSync(src, join(target, sub), { recursive: true, filter: (p) => statSync(p).isDirectory() || /\.(md|json)$/.test(p) });
  }
  const index = indexMarkdown(summary);
  writeFileSync(join(target, 'INDEX.md'), index);
  return { index, modules: summary.modules.length };
}

export const unstageKnowledge = (runDir: string) => rmSync(join(runDir, 'knowledge'), { recursive: true, force: true });
