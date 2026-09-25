# QA Flow

Local dashboard for end-to-end test flows: describe a scope in plain words, let Claude write and
prove a Playwright spec against a real environment, save it as a template, replay it against any
base URL, and post the step-by-step screenshot report to Slack.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusRage/qa-flow/main/install.sh | bash
```

Works on Linux and macOS (Intel and Apple Silicon). Needs Node.js 22.13+, pnpm (enabled through
corepack if missing) and git; on macOS: `brew install node git`. It clones to `~/.qa-flow`,
installs dependencies and Chromium, builds the dashboard, links `~/.local/bin/qa-flow` and starts it on
http://127.0.0.1:4777. Run it again to update. Options go after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/OctopusRage/qa-flow/main/install.sh | bash -s -- --service --mcp
```

| Option | |
|---|---|
| `--service` | login service: systemd user unit on Linux, launchd agent on macOS |
| `--mcp` | add the MCP server to Claude Code (user scope) |
| `--no-start` | install only |
| `--dir <path>` / `--ref <branch>` | install folder (default `~/.qa-flow`) / git ref (default `main`) |

```
qa-flow open | start | stop | restart | status | logs | update | mcp-install | run
```

AI generation uses your Claude Code login (`curl -fsSL https://claude.ai/install.sh | bash`) or an
Anthropic API key set in Settings.

## Develop

```
pnpm install
pnpm start            # builds the UI, serves http://127.0.0.1:4777
pnpm dev              # API on :4777 + Vite UI with hot reload on :5177
```

## How a run works

| Mode | What happens | AI cost |
|---|---|---|
| **Generate with AI** | Claude (Agent SDK) explores the app with scratch specs, writes `flow.spec.ts`, runs it until it passes (or fails only on a real bug), then the server runs it once more as the official result. | yes |
| **Replay template** | The template's saved spec runs directly with Playwright. | none |
| **Regenerate** (template page) | Generate, starting from the template's current spec: for UI changes. Then *Update template* on the run. | yes |

Each run lives in `data/runs/<id>/`: `flow.spec.ts`, `screenshots/`, `steps.jsonl`, `result.json`,
`run.log`, Playwright HTML `report/`, and `agent-summary.md` for AI runs.

## Screenshots on every step

Specs import the harness (`harness/qa.ts`, copied into each run):

```ts
import { test, expect, v } from './qa';

test('admin approves a held broadcast', async ({ page, browser, qa }) => {
  await qa.step('Log in as the admin', async () => {
    await page.goto('login');                        // relative: keeps a /webui/ prefix
    await page.getByLabel('Email').fill(v('ADMIN_EMAIL'));
    await page.getByLabel('Password').fill(v('ADMIN_PASSWORD'));
    await page.getByRole('button', { name: 'Log in' }).click();
  });
  const agent = await (await browser.newContext()).newPage();
  await qa.step('Agent logs in', async () => { /* … */ }, { page: agent }); // screenshot of the agent page
});
```

`qa.step()` screenshots the active page after every step, passed or failed. The run page shows
them as a flow; a test without any step screenshot is flagged in the log.

## Variables and secrets

Settings (shared, can be secret) < template (non-secret defaults) < run overrides. Specs read them
with `v('KEY')`. The AI is told only the key names of secret variables, and its Bash access is
limited to `./pw test …`, `ls`, `mkdir` and removing `scratch/`, so it cannot dump the environment.

## Run history and AI usage

**Runs** lists every run with filters kept in the URL: date presets (today, yesterday, last 7 / 30
days) or a custom range in your local time, status chips with counts, template, source (dashboard or
MCP) and text/#id search. The totals above the table (runs, pass rate, AI tokens, AI cost) follow the
filter.

AI runs record token usage (input, output, cache read, cache write, per model, with cost). It updates
live while the agent works and is kept for canceled runs. It shows on the run page, the runs table,
the dashboard (last 30 days / today), the Slack draft, and MCP `get_run` / `list_runs`
(`list_runs` takes `from` / `to` dates too). Replays use no AI tokens.

## Concurrent runs

Settings › Concurrent runs:

- **Auto (default)**: starts another queued run only while CPU is under the limit (75%) and available
  memory covers the new run's estimate (replay ≈ 300 MB + 450 MB per worker, AI ≈ 900 MB + 450 MB per
  worker) plus a headroom (1.5 GB), counting memory that just-started runs will still claim. Capped
  by *maximum runs at once* (4).
- **Fixed**: always up to N at once (1 = strictly sequential).

The first queued run always starts; runs of the same template never overlap (shared test accounts).
The dashboard's Runner card shows CPU, memory, busy slots and why each queued run is waiting.

## Settings

- **Slack token**: `xoxp` posts as you; `xoxb` needs `chat:write`, `files:write` (+ `channels:read`
  for `#name` lookups) and must be in the channel. Posting accepts a channel id, `#name`, or a
  message link (posts into that thread). More than 10 screenshots go out in batches of 10.
- **AI**: model and max turns; leave the API key blank to use your Claude Code login.
- **Playwright**: timeout, workers, headless toggle (untick to watch the browser).

Everything is stored in `data/qa-flow.db` (mode 600). The server listens on 127.0.0.1 only
(override with `HOST`/`PORT`).

## MCP server

The dashboard has a **Use QA Flow from your AI tools** card: one-click install into Claude Code
(runs `claude mcp add --scope user` locally), Cursor / VS Code install links, and copyable config.

The same process serves MCP (Streamable HTTP, stateless) at `http://127.0.0.1:4777/mcp`.
Localhost only: other Host/Origin headers get 403.

```bash
claude mcp add --transport http qa-flow http://127.0.0.1:4777/mcp          # this project
claude mcp add --transport http --scope user qa-flow http://127.0.0.1:4777/mcp  # everywhere
```

Other clients (`.mcp.json`, Cursor, etc.):

```json
{ "mcpServers": { "qa-flow": { "type": "http", "url": "http://127.0.0.1:4777/mcp" } } }
```

| Tool | What it does |
|---|---|
| `list_templates` / `get_template` | Saved flows (scope, variables, spec) |
| `start_run` | Replay `templateId`, or generate from `instruction` (+ `name`, `baseUrl`, `variables`); `wait: true` blocks and returns the result |
| `wait_for_run` / `get_run` | Step-by-step result with screenshot paths, errors, AI notes, optional log tail |
| `list_runs` / `cancel_run` | History and cancel |
| `get_screenshot` | Returns a step screenshot as an image |
| `save_run_as_template` | Save/update a template from an AI run |
| `post_run_to_slack` | Post the report (+ screenshots) to a channel or thread link |

Raw JSON-RPC:

```bash
curl -s http://127.0.0.1:4777/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_run","arguments":{"templateId":2,"wait":true}}}'
```
