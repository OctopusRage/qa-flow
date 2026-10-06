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

## API tests

Scopes about endpoints rather than screens use the `api` fixture. A test that never asks for `page`
starts no browser, and each `api.step()` records its calls (method, URL, status, request and response
bodies) in place of a screenshot:

```ts
test('admin lists contacts', async ({ api }) => {
  let token = '';
  await api.step('Log in as the admin', async () => {
    const res = await api.post('/api/v1/auth', { data: { email: v('ADMIN_EMAIL'), password: v('ADMIN_PASSWORD') } });
    expect(res.status()).toBe(200);
    token = (await res.json()).data.user.authentication_token;
  });
  await api.step('List contacts', async () => {
    const res = await api.get('/api/v1/contacts', { headers: { Authorization: token } });
    expect(res.status()).toBe(200);
  });
});
```

Requests go to the `API_BASE_URL` variable when set, else the run's base URL; a leading slash resolves
from the host root (so `/api/v1/…` skips a `/webui/` prefix). Recorded bodies mask secret variable
values and fields named like password/token/secret/key, and are cut at 4,000 characters. UI tests can
call `api` inside `qa.step()` too, e.g. to create test data; those calls show under the screenshot.

## Variables and secrets

Settings (shared, can be secret) < template (non-secret defaults) < run overrides. Specs read them
with `v('KEY')`. The AI is told only the key names of secret variables, and its Bash access is
limited to `./pw test …`, `ls`, `mkdir` and removing `scratch/`, so it cannot dump the environment.

## Knowledge pack

Settings › Knowledge pack points AI runs at a folder of notes about the app under test (or a repo
root that keeps them under `knowledge/`):

| Path | Content |
|---|---|
| `flows/<module>.md` | How the module behaves: roles, routes, endpoints, rules, known bugs. Frontmatter `description:` shows in the index. |
| `ui-map/<module>.json` | `{"components": {"<logical.id>": {"sel": ["[data-testid=\"…\"]"], "route": "…", "unverified": true?}}}` |
| `reference/*.md` | Product-wide references, e.g. API endpoint lists with payloads and auth headers. |

Each AI run gets a copy in `knowledge/` (only `.md` and `.json`) plus an index of the modules in its
prompt. The agent reads the matching flow maps before exploring and uses the selectors, but writes them
inline, so `flow.spec.ts` stays self-contained and replays don't need the pack. The copy is removed
when the run ends. The folder is read fresh on every run, so a `git pull` there updates it.

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
