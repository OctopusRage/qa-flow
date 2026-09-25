<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, fmtDuration, fmtTime, fmtTokens, fmtUsd, isLive, type RunSearch, type Template } from '../api';
import StatusBadge from '../components/StatusBadge.vue';

const route = useRoute();
const router = useRouter();
const PAGE = 50;

type Preset = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom';
const presets: { key: Preset; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom' },
];
const statuses = ['passed', 'failed', 'error', 'canceled', 'running', 'generating', 'queued'];

const q = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : '');
const preset = ref<Preset>((q('range') as Preset) || 'all');
const fromDate = ref(q('from'));
const toDate = ref(q('to'));
const status = ref<string[]>(q('status') ? q('status').split(',') : []);
const templateId = ref(q('templateId'));
const source = ref(q('source'));
const text = ref(q('q'));
const page = ref(Number(q('page') || 1));

const data = ref<RunSearch | null>(null);
const templates = ref<Template[]>([]);
const loading = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

// Local calendar days → ISO instants, so "Today" means the user's today.
const localDay = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const range = computed<{ from?: Date; to?: Date }>(() => {
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  switch (preset.value) {
    case 'today':
      return { from: today, to: addDays(today, 1) };
    case 'yesterday':
      return { from: addDays(today, -1), to: today };
    case '7d':
      return { from: addDays(today, -6), to: addDays(today, 1) };
    case '30d':
      return { from: addDays(today, -29), to: addDays(today, 1) };
    case 'custom':
      return {
        from: fromDate.value ? localDay(fromDate.value) : undefined,
        // "To" is inclusive in the UI: runs up to the end of that day.
        to: toDate.value ? addDays(localDay(toDate.value), 1) : undefined,
      };
    default:
      return {};
  }
});

const rangeLabel = computed(() => {
  const r = range.value;
  if (!r.from && !r.to) return 'all time';
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const last = r.to ? addDays(r.to, -1) : undefined;
  if (r.from && last && ymd(r.from) === ymd(last)) return fmt(r.from);
  return `${r.from ? fmt(r.from) : 'the beginning'} – ${last ? fmt(last) : 'now'}`;
});

async function load() {
  loading.value = true;
  const params = new URLSearchParams({ limit: String(PAGE), offset: String((page.value - 1) * PAGE) });
  if (range.value.from) params.set('from', range.value.from.toISOString());
  if (range.value.to) params.set('to', range.value.to.toISOString());
  if (status.value.length) params.set('status', status.value.join(','));
  if (templateId.value) params.set('templateId', templateId.value);
  if (source.value) params.set('source', source.value);
  if (text.value.trim()) params.set('q', text.value.trim());
  try {
    data.value = await api<RunSearch>(`/runs/search?${params}`);
  } finally {
    loading.value = false;
  }
}

function syncUrl() {
  const query: Record<string, string> = {};
  if (preset.value !== 'all') query.range = preset.value;
  if (preset.value === 'custom' && fromDate.value) query.from = fromDate.value;
  if (preset.value === 'custom' && toDate.value) query.to = toDate.value;
  if (status.value.length) query.status = status.value.join(',');
  if (templateId.value) query.templateId = templateId.value;
  if (source.value) query.source = source.value;
  if (text.value.trim()) query.q = text.value.trim();
  if (page.value > 1) query.page = String(page.value);
  void router.replace({ query });
}

let debounce: ReturnType<typeof setTimeout> | undefined;
watch([preset, fromDate, toDate, status, templateId, source], () => {
  page.value = 1;
  syncUrl();
  void load();
});
watch(text, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    page.value = 1;
    syncUrl();
    void load();
  }, 300);
});
watch(page, () => {
  syncUrl();
  void load();
});

function choosePreset(p: Preset) {
  if (p === 'custom' && !fromDate.value && !toDate.value) {
    const today = new Date();
    fromDate.value = ymd(addDays(today, -6));
    toDate.value = ymd(today);
  }
  preset.value = p;
}

function toggleStatus(s: string) {
  status.value = status.value.includes(s) ? status.value.filter((x) => x !== s) : [...status.value, s];
}

function reset() {
  preset.value = 'all';
  fromDate.value = '';
  toDate.value = '';
  status.value = [];
  templateId.value = '';
  source.value = '';
  text.value = '';
}

const filtered = computed(() => preset.value !== 'all' || status.value.length || templateId.value || source.value || text.value.trim());
const pages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / PAGE)));
const countFor = (s: string) => data.value?.counts[s] ?? 0;
const allCount = computed(() => Object.values(data.value?.counts ?? {}).reduce((a, b) => a + b, 0));

onMounted(async () => {
  templates.value = await api<Template[]>('/templates');
  await load();
  // Keep in-flight rows moving.
  timer = setInterval(() => {
    if (data.value?.items.some((r) => isLive(r.status))) void load();
  }, 3000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Run history</h1>
        <p>{{ data ? `${allCount} run${allCount === 1 ? '' : 's'}` : '…' }} · {{ rangeLabel }}</p>
      </div>
      <RouterLink to="/runs/new" class="btn primary">+ New run</RouterLink>
    </div>

    <section class="card filters">
      <div class="presets" role="radiogroup" aria-label="Date range">
        <button v-for="p in presets" :key="p.key" type="button" class="chip" :class="{ on: preset === p.key }" role="radio" :aria-checked="preset === p.key" @click="choosePreset(p.key)">
          {{ p.label }}
        </button>
      </div>
      <div v-if="preset === 'custom'" class="row dates">
        <label>From <input v-model="fromDate" type="date" :max="toDate || undefined" /></label>
        <label>To <input v-model="toDate" type="date" :min="fromDate || undefined" /></label>
      </div>
      <div class="row selects">
        <input v-model="text" type="text" placeholder="Search name, URL or #id" aria-label="Search runs" class="grow" />
        <select v-model="templateId" aria-label="Template">
          <option value="">All templates</option>
          <option v-for="t in templates" :key="t.id" :value="String(t.id)">{{ t.name }}</option>
        </select>
        <select v-model="source" aria-label="Source">
          <option value="">Dashboard + MCP</option>
          <option value="ui">Dashboard</option>
          <option value="mcp">MCP</option>
        </select>
        <button v-if="filtered" class="btn small ghost" type="button" @click="reset">Clear filters</button>
      </div>
      <div class="statuses">
        <button v-for="s in statuses" :key="s" type="button" class="chip status" :class="[s, { on: status.includes(s) }]" :aria-pressed="status.includes(s)" @click="toggleStatus(s)">
          {{ s }} <span class="n">{{ countFor(s) }}</span>
        </button>
      </div>
    </section>

    <div v-if="data" class="grid cols-4 totals">
      <div class="card stat"><div class="label">Runs</div><div class="value">{{ allCount }}</div></div>
      <div class="card stat">
        <div class="label">Pass rate</div>
        <div class="value">{{ countFor('passed') + countFor('failed') ? `${Math.round((100 * countFor('passed')) / (countFor('passed') + countFor('failed')))}%` : '—' }}</div>
      </div>
      <div class="card stat" :title="`input ${data.usage.input.toLocaleString()} · output ${data.usage.output.toLocaleString()} · cache read ${data.usage.cacheRead.toLocaleString()} · cache write ${data.usage.cacheWrite.toLocaleString()}`">
        <div class="label">AI tokens</div>
        <div class="value">{{ fmtTokens(data.usage.tokens) }}</div>
        <div class="faint small">{{ data.usage.aiRuns }} AI run{{ data.usage.aiRuns === 1 ? '' : 's' }}</div>
      </div>
      <div class="card stat"><div class="label">AI cost</div><div class="value">{{ fmtUsd(data.usage.costUsd) }}</div></div>
    </div>

    <section class="card" style="margin-top: 16px">
      <div v-if="data && !data.items.length" class="empty">
        No runs {{ filtered ? 'match these filters' : 'yet' }}.
        <a v-if="filtered" href="#" @click.prevent="reset">Clear filters</a>
      </div>
      <div v-else class="table-wrap" :class="{ dim: loading }">
        <table class="list">
          <thead>
            <tr><th>Run</th><th>Status</th><th>Result</th><th>AI tokens</th><th>Started</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in data?.items ?? []" :key="r.id" class="clickable" @click="router.push(`/runs/${r.id}`)">
              <td>
                <div><strong>#{{ r.id }}</strong> {{ r.name }}</div>
                <div class="faint small">
                  <span v-if="r.source === 'mcp'" class="src">MCP</span>
                  {{ r.mode === 'generate' ? 'AI generate' : 'Replay' }} · {{ r.base_url }}
                </div>
              </td>
              <td><StatusBadge :status="r.status" /></td>
              <td class="small">
                <template v-if="r.summary">{{ r.summary.passed }}/{{ r.summary.total }} · {{ fmtDuration(r.summary.durationMs) }}</template>
                <span v-else class="faint">—</span>
              </td>
              <td class="small" :title="r.tokens ? `input ${r.tokens.input.toLocaleString()} · output ${r.tokens.output.toLocaleString()} · cache read ${r.tokens.cacheRead.toLocaleString()} · cache write ${r.tokens.cacheWrite.toLocaleString()}` : 'No AI used'">
                <template v-if="r.tokens">{{ fmtTokens(r.tokens.total) }}<span class="faint"> · {{ fmtUsd(r.cost_usd) }}</span></template>
                <span v-else class="faint">—</span>
              </td>
              <td class="small muted" :title="new Date(r.created_at).toLocaleString()">{{ fmtTime(r.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="pages > 1" class="row pager">
        <button class="btn small" :disabled="page <= 1" @click="page -= 1">‹ Newer</button>
        <span class="muted small">Page {{ page }} of {{ pages }}</span>
        <button class="btn small" :disabled="page >= pages" @click="page += 1">Older ›</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-direction: column; gap: 12px; }
.presets, .statuses { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.chip:hover { background: var(--surface-2); }
.chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.chip.status { text-transform: capitalize; }
.chip .n { color: var(--faint); font-size: 12px; margin-left: 2px; }
.chip.on .n { color: inherit; }
.dates label { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.dates input { width: auto; }
.selects select { width: auto; max-width: 220px; }
.grow { flex: 1; min-width: 180px; }
.totals { margin-top: 16px; }
.src { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; padding: 0 6px; border-radius: 4px; background: var(--accent-soft); color: var(--accent); margin-right: 4px; }
.dim { opacity: 0.6; transition: opacity 0.2s; }
.pager { justify-content: center; margin-top: 12px; }
@media (max-width: 640px) { .selects select { max-width: none; flex: 1; } }
</style>
