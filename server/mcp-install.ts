import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

// One-click install of this server into Claude Code (user scope) by running the `claude` CLI,
// which the app can do because it runs locally as the same user.

const NAME = 'qa-flow';

type Exec = { code: number; out: string };

function claude(args: string[]): Promise<Exec> {
  return new Promise((resolve) => {
    // Home as cwd so project/local scopes of whatever folder the server started in don't interfere.
    execFile('claude', args, { cwd: homedir(), timeout: 30_000, env: process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 127) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export type McpInstallStatus = {
  url: string;
  cli: boolean;
  installed: boolean;
  installedUrl: string | null;
  scope: string | null;
  upToDate: boolean;
};

export async function mcpStatus(url: string): Promise<McpInstallStatus> {
  const version = await claude(['--version']);
  if (version.code !== 0) return { url, cli: false, installed: false, installedUrl: null, scope: null, upToDate: false };
  const get = await claude(['mcp', 'get', NAME]);
  if (get.code !== 0) return { url, cli: true, installed: false, installedUrl: null, scope: null, upToDate: false };
  const installedUrl = get.out.match(/URL:\s*(\S+)/)?.[1] ?? null;
  const scope = get.out.match(/Scope:\s*([^\n(]+)/)?.[1]?.trim() ?? null;
  return { url, cli: true, installed: true, installedUrl, scope, upToDate: installedUrl === url };
}

export async function mcpInstall(url: string): Promise<McpInstallStatus> {
  const current = await mcpStatus(url);
  if (!current.cli) throw new Error('The `claude` CLI was not found on PATH for the qa-flow server');
  if (current.upToDate) return current;
  // A stale entry (other port/URL) is replaced.
  if (current.installed) await claude(['mcp', 'remove', NAME, '--scope', 'user']);
  const add = await claude(['mcp', 'add', '--transport', 'http', '--scope', 'user', NAME, url]);
  if (add.code !== 0) throw new Error(add.out || 'claude mcp add failed');
  return mcpStatus(url);
}

export async function mcpUninstall(url: string): Promise<McpInstallStatus> {
  const r = await claude(['mcp', 'remove', NAME, '--scope', 'user']);
  if (r.code !== 0 && !/No (MCP server|.*found)/i.test(r.out)) throw new Error(r.out || 'claude mcp remove failed');
  return mcpStatus(url);
}
