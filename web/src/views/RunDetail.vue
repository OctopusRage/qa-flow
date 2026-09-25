<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorText, fileUrl, fmtDuration, fmtTime, fmtTokens, fmtUsd, isLive, toast, type Run, type RunDetail, type Template, type TokenUsage } from '../api';
import StatusBadge from '../components/StatusBadge.vue';
import SlackDialog from '../components/SlackDialog.vue';
import Lightbox, { type Shot } from '../components/Lightbox.vue';

const props = defineProps<{ id: string }>();
const router = useRouter();
const runId = Number(props.id);

const detail = ref<RunDetail | null>(null);
const logText = ref('');
const tab = ref<'flow' | 'log' | 'spec' | 'summary'>('flow');
const showSlack = ref(false);
const showSave = ref(false);
const saveName = ref('');
const saveDescription = ref('');
const saveMode = ref<'update' | 'new'>('new');
const busy = ref(false);
const lightbox = ref<number | null>(null);
const logEl = ref<HTMLElement | null>(null);
let source: EventSource | null = null;

const run = computed(() => detail.value?.run);
const live = computed(() => !!run.value && isLive(run.value.status));
const tests = computed(() => detail.value?.result?.tests ?? []);

// One flat list so the lightbox can page through every step of every test.
const shots = computed<Shot[]>(() =>
  tests.value.flatMap((t) =>
    t.steps.filter((s) => s.screenshot).map((s) => ({ src: fileUrl(runId, s.screenshot!), caption: `${t.title} › ${s.index}. ${s.title}`, status: s.status })),
  ),
);
const shotIndex = (path: string) => shots.value.findIndex((s) => s.src === fileUrl(runId, path));

async function load() {
  detail.value = await api<RunDetail>(`/runs/${runId}`);
  if (!tests.value.length && live.value) tab.value = 'log';
}

async function loadLog() {
  logText.value = await fetch(`/api/runs/${runId}/log`).then((r) => r.text());
  scrollLog();
}

function scrollLog() {
  void nextTick(() => {
    const el = logEl.value;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  });
}

function connect() {
  source = new EventSource(`/api/runs/${runId}/events`);
  source.onmessage = (m) => {
    const e = JSON.parse(m.data) as { type: 'log'; line: string } | { type: 'status'; status: string } | { type: 'usage'; tokens: TokenUsage; costUsd: number | null };
    if (e.type === 'usage') {
      if (detail.value) {
        detail.value.run.tokens = e.tokens;
        if (e.costUsd != null) detail.value.run.cost_usd = e.costUsd;
      }
    } else if (e.type === 'log') {
      logText.value += `${e.line}\n`;
      scrollLog();
      if (e.line.startsWith('⏳')) void load();
    } else {
      void load().then(() => {
        if (!live.value) tab.value = 'flow';
      });
    }
  };
}

onMounted(async () => {
  await Promise.all([load(), loadLog()]);
  connect();
});
onBeforeUnmount(() => source?.close());

async function act(fn: () => Promise<void>) {
  busy.value = true;
  try {
    await fn();
  } catch (e) {
    toast(errorText(e));
  } finally {
    busy.value = false;
  }
}

const cancelRun = () => act(async () => { await api(`/runs/${runId}/cancel`, { method: 'POST', body: {} }); toast('Cancel requested'); });
const rerun = () => act(async () => { const r = await api<Run>(`/runs/${runId}/rerun`, { body: {} }); router.push(`/runs/${r.id}`); });
const remove = () =>
  act(async () => {
    if (!confirm(`Delete run #${runId} and its screenshots?`)) return;
    await api(`/runs/${runId}`, { method: 'DELETE' });
    router.push('/');
  });

function openSave() {
  saveMode.value = detail.value?.template ? 'update' : 'new';
  saveName.value = run.value?.name ?? '';
  saveDescription.value = '';
  showSave.value = true;
}
const saveTemplate = () =>
  act(async () => {
    const body = saveMode.value === 'update' && detail.value?.template ? { templateId: detail.value.template.id } : { name: saveName.value, description: saveDescription.value };
    const t = await api<Template>(`/runs/${runId}/save-template`, { body });
    showSave.value = false;
    toast(`Saved template “${t.name}”`);
    await load();
  });

const canSave = computed(() => !!detail.value?.spec && run.value?.mode === 'generate' && !live.value);
</script>

<template>
  <div v-if="run" class="page">
    <div class="crumbs small"><RouterLink to="/">Dashboard</RouterLink> › Run #{{ run.id }}</div>
    <div class="page-head">
      <div style="min-width: 0">
        <div class="row">
          <h1>{{ run.name }}</h1>
          <StatusBadge :status="run.status" />
        </div>
        <p class="meta">
          <span>{{ run.mode === 'generate' ? '✨ AI generated' : '▶ Replay' }}<template v-if="run.source === 'mcp'"> · via MCP</template></span>
          <span class="mono">{{ run.base_url }}</span>
          <span>{{ fmtTime(run.created_at) }}</span>
          <span v-if="run.summary">{{ fmtDuration(run.summary.durationMs) }}</span>
          <span v-if="run.tokens" :title="`input ${run.tokens.input.toLocaleString()} · output ${run.tokens.output.toLocaleString()} · cache read ${run.tokens.cacheRead.toLocaleString()} · cache write ${run.tokens.cacheWrite.toLocaleString()}`">
            AI {{ fmtTokens(run.tokens.total) }} tokens<template v-if="run.cost_usd != null"> · ~{{ fmtUsd(run.cost_usd) }}</template>
          </span>
          <span v-else-if="run.cost_usd != null">AI ~{{ fmtUsd(run.cost_usd) }}</span>
          <RouterLink v-if="detail?.template" :to="`/templates/${detail.template.id}`">Template: {{ detail.template.name }}</RouterLink>
        </p>
      </div>
      <div class="row">
        <button v-if="live" class="btn danger" :disabled="busy" @click="cancelRun">■ Cancel</button>
        <template v-else>
          <button class="btn" :disabled="busy" @click="rerun">↻ Rerun</button>
          <button v-if="canSave" class="btn" :disabled="busy" @click="openSave">💾 {{ detail?.template ? 'Update template' : 'Save as template' }}</button>
          <a v-if="detail?.hasReport" class="btn" :href="fileUrl(run.id, 'report/index.html')" target="_blank" rel="noopener">Playwright report ↗</a>
          <button class="btn primary" @click="showSlack = true">Post to Slack</button>
          <button class="btn ghost danger" title="Delete run" aria-label="Delete run" @click="remove">🗑</button>
        </template>
      </div>
    </div>

    <div v-if="run.summary" class="grid cols-4 summary">
      <div class="card stat"><div class="label">Tests</div><div class="value">{{ run.summary.total }}</div></div>
      <div class="card stat"><div class="label">Passed</div><div class="value pass">{{ run.summary.passed }}</div></div>
      <div class="card stat"><div class="label">Failed</div><div class="value" :class="{ fail: run.summary.failed }">{{ run.summary.failed }}</div></div>
      <div class="card stat"><div class="label">Steps captured</div><div class="value">{{ shots.length }}</div></div>
    </div>
    <p v-if="run.status === 'queued'" class="notice" style="margin-top: 12px">⏳ {{ detail?.queue.waiting[run.id] ?? 'Waiting for a free run slot' }}</p>
    <p v-if="run.error" class="error-box" style="margin-top: 12px">{{ run.error }}</p>
    <p v-if="detail?.result?.error" class="error-box" style="margin-top: 12px">{{ detail.result.error }}</p>
    <p v-if="run.slack.length" class="notice small" style="margin-top: 12px">
      Posted to Slack
      <template v-for="(s, i) in run.slack" :key="i">
        · <a v-if="s.permalink" :href="s.permalink" target="_blank" rel="noopener">{{ fmtTime(s.at) }}</a><span v-else>{{ fmtTime(s.at) }}</span>
      </template>
    </p>

    <section v-if="run.tokens" class="card usage">
      <div class="row" style="margin-bottom: 10px">
        <h2 style="margin: 0">AI usage</h2>
        <span v-if="live" class="badge generating">counting</span>
        <span class="spacer" />
        <strong>{{ run.tokens.total.toLocaleString() }} tokens</strong>
        <span v-if="run.cost_usd != null" class="muted">· ~{{ fmtUsd(run.cost_usd) }}</span>
      </div>
      <div class="usage-grid">
        <div><span class="muted small">Input</span><strong>{{ run.tokens.input.toLocaleString() }}</strong></div>
        <div><span class="muted small">Output</span><strong>{{ run.tokens.output.toLocaleString() }}</strong></div>
        <div><span class="muted small">Cache read</span><strong>{{ run.tokens.cacheRead.toLocaleString() }}</strong></div>
        <div><span class="muted small">Cache write</span><strong>{{ run.tokens.cacheWrite.toLocaleString() }}</strong></div>
      </div>
      <table v-if="Object.keys(run.tokens.models).length > 1 || !live" class="list models">
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Cost</th></tr></thead>
        <tbody>
          <tr v-for="(m, name) in run.tokens.models" :key="name">
            <td class="mono small">{{ name }}</td>
            <td>{{ fmtTokens(m.input) }}</td>
            <td>{{ fmtTokens(m.output) }}</td>
            <td>{{ fmtTokens(m.cacheRead) }}</td>
            <td>{{ fmtTokens(m.cacheWrite) }}</td>
            <td>{{ m.costUsd ? fmtUsd(m.costUsd) : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="tabs" style="margin-top: 20px" role="tablist">
      <button :class="{ active: tab === 'flow' }" @click="tab = 'flow'">Flow</button>
      <button :class="{ active: tab === 'log' }" @click="tab = 'log'">Log <span v-if="live" class="badge running" style="margin-left: 4px">live</span></button>
      <button :class="{ active: tab === 'spec' }" :disabled="!detail?.spec" @click="tab = 'spec'">Spec</button>
      <button v-if="detail?.agentSummary" :class="{ active: tab === 'summary' }" @click="tab = 'summary'">AI notes</button>
    </div>

    <section v-show="tab === 'flow'">
      <div v-if="!tests.length" class="card empty">
        <template v-if="live">{{ run.status === 'generating' ? 'The AI is exploring the app and writing the flow…' : 'Running…' }} Follow along in the <a href="#" @click.prevent="tab = 'log'">log</a>.</template>
        <template v-else>No test results for this run.</template>
      </div>
      <div v-for="t in tests" :key="t.id" class="card test">
        <div class="row test-head">
          <StatusBadge :status="t.status" />
          <strong class="grow">{{ t.title }}</strong>
          <span class="muted small">{{ t.steps.length }} steps · {{ fmtDuration(t.durationMs) }}<template v-if="t.retries"> · retry {{ t.retries }}</template></span>
        </div>
        <ol class="flow">
          <li v-for="s in t.steps" :key="s.index" class="step" :class="s.status">
            <button v-if="s.screenshot" class="thumb" :aria-label="`Open screenshot for ${s.title}`" @click="lightbox = shotIndex(s.screenshot)">
              <img :src="fileUrl(run.id, s.screenshot)" :alt="s.title" loading="lazy" />
            </button>
            <div v-else class="thumb none">no screenshot</div>
            <div class="step-body">
              <div class="step-title"><span class="num">{{ s.index }}</span>{{ s.title }}</div>
              <div class="faint small">{{ s.status === 'failed' ? '✖ failed' : s.status === 'info' ? 'snapshot' : '✓ passed' }} · {{ fmtDuration(s.durationMs) }}</div>
              <pre v-if="s.error" class="step-error">{{ s.error }}</pre>
            </div>
          </li>
        </ol>
        <pre v-if="t.error && !t.steps.some((s) => s.error)" class="error-box small" style="margin: 12px 0 0">{{ t.error }}</pre>
      </div>
    </section>

    <section v-show="tab === 'log'">
      <pre ref="logEl" class="log">{{ logText || 'Waiting for output…' }}</pre>
    </section>

    <section v-if="tab === 'spec' && detail?.spec">
      <pre class="log">{{ detail.spec }}</pre>
    </section>

    <section v-if="tab === 'summary' && detail?.agentSummary" class="card">
      <pre class="notes">{{ detail.agentSummary }}</pre>
    </section>

    <Lightbox v-model="lightbox" :shots="shots" />
    <SlackDialog v-if="showSlack" :run-id="run.id" @close="showSlack = false" @posted="showSlack = false; load()" />

    <div v-if="showSave" class="modal-backdrop" @click.self="showSave = false">
      <form class="modal" style="width: min(520px, 100%)" @submit.prevent="saveTemplate">
        <div class="modal-head"><h2 style="margin: 0">Save flow as template</h2></div>
        <div v-if="detail?.template" class="row" style="margin-bottom: 14px">
          <label><input v-model="saveMode" type="radio" value="update" /> Update “{{ detail.template.name }}”</label>
          <label><input v-model="saveMode" type="radio" value="new" /> Save as a new template</label>
        </div>
        <template v-if="saveMode === 'new'">
          <label class="field"><span>Name</span><input v-model="saveName" type="text" required /></label>
          <label class="field"><span>Description</span><input v-model="saveDescription" type="text" placeholder="Optional" /></label>
        </template>
        <p class="muted small">Stores this run's spec, scope and base URL. Replays run the spec directly, with no AI cost.</p>
        <div class="row" style="justify-content: flex-end">
          <button class="btn" type="button" @click="showSave = false">Cancel</button>
          <button class="btn primary" type="submit" :disabled="busy">Save</button>
        </div>
      </form>
    </div>
  </div>
  <div v-else class="page empty">Loading…</div>
</template>

<style scoped>
.usage { margin-top: 16px; }
.usage-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.usage-grid div { display: flex; flex-direction: column; }
.models { margin-top: 12px; }
.table-scroll { overflow-x: auto; }
@media (max-width: 640px) { .usage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .models { display: block; overflow-x: auto; } }
.crumbs { color: var(--muted); margin-bottom: 6px; }
.meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.meta .mono { word-break: break-all; }
.summary { margin-bottom: 4px; }
.value.pass { color: var(--pass); }
.value.fail { color: var(--fail); }
.test { padding: 14px; }
.test-head { margin-bottom: 12px; }
.grow { flex: 1; min-width: 0; }
.flow { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; counter-reset: step; }
.step { position: relative; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--surface); display: flex; flex-direction: column; }
.step.failed { border-color: var(--fail); box-shadow: 0 0 0 1px var(--fail); }
.step::after { content: '→'; position: absolute; right: -13px; top: 58px; color: var(--faint); font-size: 14px; }
.step:last-child::after { content: none; }
.thumb { display: block; width: 100%; border: 0; padding: 0; cursor: zoom-in; background: var(--surface-2); aspect-ratio: 16 / 10; }
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.thumb.none { display: grid; place-items: center; color: var(--faint); font-size: 12px; cursor: default; }
.step-body { padding: 10px 12px; border-top: 1px solid var(--border); }
.step-title { font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.num { flex: none; display: inline-grid; place-items: center; min-width: 20px; height: 20px; border-radius: 50%; background: var(--pass-soft); color: var(--pass); font-size: 11px; }
.step.failed .num { background: var(--fail-soft); color: var(--fail); }
.step.info .num { background: var(--info-soft); color: var(--info); }
.step-error { margin: 8px 0 0; font-size: 11.5px; color: var(--fail); white-space: pre-wrap; word-break: break-word; max-height: 160px; overflow: auto; }
.notes { white-space: pre-wrap; margin: 0; font: inherit; }
.tabs button:disabled { opacity: 0.4; cursor: default; }
</style>
