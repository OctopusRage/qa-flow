<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, errorText, toast } from '../api';

type Status = { url: string; cli: boolean; installed: boolean; installedUrl: string | null; scope: string | null; upToDate: boolean };

const status = ref<Status | null>(null);
const busy = ref(false);
const error = ref('');
const open = ref(false);

const url = computed(() => status.value?.url ?? `http://127.0.0.1:${location.port || 4777}/mcp`);
const command = computed(() => `claude mcp add --transport http --scope user qa-flow ${url.value}`);
const json = computed(() => JSON.stringify({ mcpServers: { 'qa-flow': { type: 'http', url: url.value } } }, null, 2));
const cursorLink = computed(() => `cursor://anysphere.cursor-deeplink/mcp/install?name=qa-flow&config=${btoa(JSON.stringify({ url: url.value }))}`);
const vscodeLink = computed(() => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'qa-flow', type: 'http', url: url.value }))}`);

async function load() {
  try {
    status.value = await api<Status>('/mcp/status');
    open.value = !status.value.installed;
  } catch (e) {
    error.value = errorText(e);
  }
}
onMounted(load);

async function run(action: 'install' | 'uninstall') {
  busy.value = true;
  error.value = '';
  try {
    status.value = await api<Status>(`/mcp/${action}`, { body: {} });
    toast(action === 'install' ? 'Installed in Claude Code. Start a new Claude session to use it' : 'Removed from Claude Code');
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast('Copy failed: select the text manually');
  }
}
</script>

<template>
  <section class="card mcp">
    <div class="row head">
      <span class="plug" aria-hidden="true">⚡</span>
      <div class="grow">
        <h2 style="margin: 0">Use QA Flow from your AI tools (MCP)</h2>
        <p class="muted small" style="margin: 2px 0 0">
          Run flows, read step results and screenshots, and post to Slack from Claude Code, Cursor or VS Code.
          <code>{{ url }}</code>
        </p>
      </div>
      <template v-if="status">
        <span v-if="status.installed && status.upToDate" class="badge passed">Installed in Claude Code</span>
        <span v-else-if="status.installed" class="badge flaky">Installed with an old URL</span>
      </template>
      <button class="btn small ghost" :aria-expanded="open" @click="open = !open">{{ open ? 'Hide' : 'Show' }}</button>
    </div>

    <div v-if="open" class="body">
      <div class="clients">
        <div class="client">
          <strong>Claude Code</strong>
          <p class="muted small">Adds it for your user (every project) by running <code>claude mcp add</code> on this machine.</p>
          <p v-if="status?.installed && status.upToDate" class="small" style="color: var(--pass); margin: 0 0 4px">✓ Installed ({{ status.scope || 'user' }}). Open a new Claude session to use it.</p>
          <p v-else-if="status?.installed" class="small" style="color: var(--warn); margin: 0 0 4px">Points to {{ status.installedUrl }}</p>
          <div class="row">
            <button v-if="!status?.installed || !status.upToDate" class="btn primary" :disabled="busy || status?.cli === false" @click="run('install')">
              {{ busy ? 'Installing…' : status?.installed ? 'Update URL' : 'Install in Claude Code' }}
            </button>
            <button v-if="status?.installed" class="btn ghost danger small" :disabled="busy" @click="run('uninstall')">Uninstall</button>
          </div>
          <p v-if="status?.cli === false" class="small" style="color: var(--warn)">The <code>claude</code> CLI isn't on the server's PATH. Use the command below instead.</p>
        </div>
        <div class="client">
          <strong>Cursor</strong>
          <p class="muted small">Opens Cursor's install prompt.</p>
          <a class="btn" :href="cursorLink">Add to Cursor</a>
        </div>
        <div class="client">
          <strong>VS Code</strong>
          <p class="muted small">Opens VS Code's MCP install prompt (Copilot agent mode).</p>
          <a class="btn" :href="vscodeLink">Add to VS Code</a>
        </div>
      </div>

      <div class="manual">
        <div class="row"><strong class="grow">Command</strong><button class="btn small" @click="copy(command, 'Command')">Copy</button></div>
        <pre class="log snippet">{{ command }}</pre>
        <div class="row"><strong class="grow">Config JSON</strong><span class="muted small">.mcp.json, Cursor, Windsurf…</span><button class="btn small" @click="copy(json, 'JSON')">Copy</button></div>
        <pre class="log snippet">{{ json }}</pre>
      </div>
      <p class="muted small" style="margin: 10px 0 0">
        Try: <em>“Use qa-flow to replay template 2 against https://…/webui/ and wait for the result.”</em> The server must be running for the tools to work.
      </p>
      <p v-if="error" class="error-box small">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.mcp { margin-top: 16px; }
.head { flex-wrap: nowrap; align-items: flex-start; }
.plug { font-size: 20px; line-height: 1.2; }
.grow { flex: 1; min-width: 0; }
.head code { word-break: break-all; }
.body { margin-top: 14px; }
.clients { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.client { border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.client p { margin: 0 0 8px; flex: 1; }
.manual { margin-top: 14px; }
.snippet { margin: 6px 0 12px; padding: 10px 12px; max-height: none; }
@media (max-width: 760px) {
  .clients { grid-template-columns: minmax(0, 1fr); }
  .head { flex-wrap: wrap; }
}
</style>
