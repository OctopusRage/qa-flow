<script setup lang="ts">
// The test library (the pack's cases/, read-only): Module → Feature tree on the left, that feature's cases (or a
// search's) on the right, a case's steps and history in a modal. Picked cases become a generate run.
// Navigation inside the page uses history.replaceState, not the router: the shell keys RouterView by
// fullPath, so a router push would remount the page and drop the selection.
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { BASE, api, errorText, fmtTime, type LibraryModule, type LibraryStatus, type LibraryTc, type LibraryTcDetail } from '../api';
import StatusBadge from '../components/StatusBadge.vue';

const props = defineProps<{ code?: string }>();
const route = useRoute();
const router = useRouter();

const status = ref<LibraryStatus | null | undefined>(undefined);
const tree = ref<LibraryModule[]>([]);
const open = ref(new Set<string>());
const featureId = ref<string | null>(typeof route.query.f === 'string' ? route.query.f : null);
const query = ref(typeof route.query.q === 'string' ? route.query.q : '');
const statusFilter = ref('');
const surfaceFilter = ref('');
const cases = ref<LibraryTc[] | null>(null);
const loading = ref(false);
const error = ref('');
const selected = ref(new Map<string, LibraryTc>());
const detail = ref<LibraryTcDetail | null>(null);

const SURFACES = ['UI_WEB', 'API', 'MIXED', 'ANDROID', 'IOS'];
const MOBILE = new Set(['ANDROID', 'IOS']);

const feature = computed(() => {
  for (const m of tree.value) for (const f of m.features) if (f.id === featureId.value) return { module: m, feature: f };
  return null;
});
const shown = computed(() =>
  (cases.value ?? []).filter((t) => (!statusFilter.value || t.status === statusFilter.value) && (!surfaceFilter.value || t.surface === surfaceFilter.value)),
);
const picked = computed(() => [...selected.value.values()]);
const pickedMobile = computed(() => picked.value.filter((t) => MOBILE.has(t.surface)).length);
const allShownPicked = computed(() => shown.value.length > 0 && shown.value.every((t) => selected.value.has(t.code)));

onMounted(async () => {
  try {
    status.value = await api<LibraryStatus | null>('/library');
    if (!status.value) return;
    tree.value = await api<LibraryModule[]>('/library/tree');
    if (props.code) await showCase(props.code, true);
    if (query.value.trim()) await search();
    else if (featureId.value && !cases.value) await pickFeature(featureId.value);
    if (feature.value) open.value.add(feature.value.module.id);
  } catch (e) {
    error.value = errorText(e);
  }
});

function syncUrl(code = detail.value?.code) {
  const params = new URLSearchParams();
  if (query.value.trim()) params.set('q', query.value.trim());
  else if (featureId.value) params.set('f', featureId.value);
  const qs = params.toString();
  history.replaceState(history.state, '', `${BASE}library${code ? `/${encodeURIComponent(code)}` : ''}${qs ? `?${qs}` : ''}`);
}

function toggleModule(id: string) {
  open.value.has(id) ? open.value.delete(id) : open.value.add(id);
}

async function pickFeature(id: string) {
  featureId.value = id;
  query.value = '';
  syncUrl();
  await load(() => api<LibraryTc[]>(`/library/features/${encodeURIComponent(id)}`));
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (q, old) => {
  if (q === old) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => (q.trim() ? search() : featureId.value ? pickFeature(featureId.value) : (cases.value = null, syncUrl())), 250);
});

async function search() {
  syncUrl();
  await load(() => api<LibraryTc[]>(`/library/search?q=${encodeURIComponent(query.value.trim())}&limit=150`));
}

async function load(fn: () => Promise<LibraryTc[]>) {
  loading.value = true;
  error.value = '';
  try {
    cases.value = await fn();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

function toggle(t: LibraryTc) {
  selected.value.has(t.code) ? selected.value.delete(t.code) : selected.value.set(t.code, t);
}
function toggleAll() {
  const all = allShownPicked.value;
  for (const t of shown.value) all ? selected.value.delete(t.code) : selected.value.set(t.code, t);
}

async function showCase(code: string, fromUrl = false) {
  try {
    detail.value = await api<LibraryTcDetail>(`/library/tc/${encodeURIComponent(code)}`);
    if (fromUrl && !featureId.value && !query.value) await pickFeature(detail.value.featureId);
    syncUrl(code);
  } catch (e) {
    error.value = errorText(e);
  }
}
function closeCase() {
  detail.value = null;
  syncUrl();
}

function runPicked(list = picked.value) {
  router.push(`/runs/new?mode=generate&qtm=${encodeURIComponent(list.map((t) => t.code).join(','))}`);
}

const resultClass = (s?: string) => ({ PASS: 'passed', FAIL: 'failed', BLOCKED: 'incomplete', SKIP: 'canceled' })[s ?? ''] ?? '';
const short = (iso?: string | null) => (iso ? fmtTime(iso) : '');
</script>

<template>
  <div class="page wide">
    <div class="page-head">
      <div>
        <h1>Test library</h1>
        <p>
          The QA team's test cases, by module and feature. Search before you write a new one; pick cases and run them with AI.
          <span v-if="status" class="faint small">{{ status.tcs }} cases · {{ status.active }} active · synced {{ fmtTime(status.updatedAt) }}</span>
        </p>
      </div>
    </div>

    <div v-if="status === null" class="card empty">
      No test library yet. Point <RouterLink to="/settings">Settings › Knowledge pack</RouterLink> at a pack with a <code>cases/</code> folder.
    </div>
    <div v-else-if="error && !tree.length" class="error-box">{{ error }}</div>

    <div v-else-if="status" class="lib">
      <aside class="card tree" aria-label="Modules and features">
        <div v-for="m in tree" :key="m.id" class="mod">
          <button class="mod-head" :aria-expanded="open.has(m.id)" @click="toggleModule(m.id)">
            <span class="caret" :class="{ on: open.has(m.id) }">▸</span>
            <span class="name">{{ m.name }}</span>
            <span class="count">{{ m.tcs }}</span>
          </button>
          <ul v-if="open.has(m.id)">
            <li v-for="f in m.features" :key="f.id">
              <button class="feat" :class="{ active: f.id === featureId && !query.trim() }" @click="pickFeature(f.id)">
                <span class="name">{{ f.name }}</span>
                <span class="count" :title="`${f.active} active`">{{ f.tcs }}</span>
              </button>
            </li>
          </ul>
        </div>
      </aside>

      <section class="card cases">
        <div class="toolbar">
          <input v-model="query" type="search" class="q" placeholder="Search all cases: unserved count, auto resolve, QTC-INBOX-0325…" aria-label="Search test cases" />
          <select v-model="statusFilter" aria-label="Status">
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="DRAFT">Draft</option>
            <option value="NEEDS_REVIEW">Needs review</option>
          </select>
          <select v-model="surfaceFilter" aria-label="Surface">
            <option value="">All surfaces</option>
            <option v-for="s in SURFACES" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>

        <div class="heading">
          <strong v-if="query.trim()">Search: “{{ query.trim() }}”</strong>
          <strong v-else-if="feature">{{ feature.module.name }} › {{ feature.feature.name }}</strong>
          <span v-else class="muted">Pick a feature on the left, or search.</span>
          <span v-if="cases" class="faint small">{{ shown.length }}{{ shown.length !== cases.length ? ` of ${cases.length}` : '' }} cases</span>
          <span v-if="feature?.feature.flowRef && !query.trim()" class="faint small mono">{{ feature.feature.flowRef.replace(/^knowledge\//, '') }}</span>
        </div>

        <div v-if="error" class="error-box">{{ error }}</div>
        <div v-if="loading" class="empty">Loading…</div>
        <div v-else-if="cases && !shown.length" class="empty">Nothing here{{ query.trim() ? ' — no case matches. That is a gap: a new test case is worth writing.' : '.' }}</div>
        <div v-else-if="cases" class="table-wrap">
          <table class="list">
            <thead>
              <tr>
                <th class="pick"><input type="checkbox" :checked="allShownPicked" aria-label="Select all shown" @change="toggleAll" /></th>
                <th>Case</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Last result</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in shown" :key="t.code" class="clickable" @click="showCase(t.code)">
                <td class="pick" @click.stop><input type="checkbox" :checked="selected.has(t.code)" :aria-label="`Select ${t.code}`" @change="toggle(t)" /></td>
                <td>
                  <span class="mono small code">{{ t.code }}</span> {{ t.title }}
                  <span v-if="t.spec" class="chip spec" title="A passing spec is saved: replays with no AI">▶ spec</span>
                  <div class="faint small">
                    {{ t.surface }} · {{ t.testType }}<template v-if="t.roles.length"> · {{ t.roles.join(', ') }}</template>
                    <template v-if="query.trim()"> · {{ t.module }} › {{ t.feature }}</template>
                  </div>
                </td>
                <td class="small">{{ t.priority }}</td>
                <td><span class="tc-status" :class="t.status.toLowerCase()">{{ t.status }}</span></td>
                <td>
                  <span v-if="t.last" class="badge" :class="resultClass(t.last.status)" :title="t.last.run">{{ t.last.status }}</span>
                  <span v-else class="faint small">never</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div v-if="picked.length" class="pickbar card" role="region" aria-label="Selected cases">
      <strong>{{ picked.length }} selected</strong>
      <span class="faint small mono picked-codes">{{ picked.map((t) => t.code).join(', ') }}</span>
      <span v-if="pickedMobile" class="small" style="color: var(--warn)">{{ pickedMobile }} mobile case(s) cannot run in a browser</span>
      <span class="spacer" />
      <button class="btn small ghost" @click="selected.clear()">Clear</button>
      <button class="btn primary" @click="runPicked()">✨ Run {{ picked.length }} with AI</button>
    </div>

    <div v-if="detail" class="modal-backdrop" @click.self="closeCase">
      <div class="modal case" role="dialog" aria-modal="true" :aria-label="detail.code">
        <div class="modal-head">
          <div>
            <div class="mono small faint">{{ detail.code }} · v{{ detail.version }} · {{ detail.module }} › {{ detail.feature }}</div>
            <h2>{{ detail.title }}</h2>
          </div>
          <button class="btn ghost small" aria-label="Close" @click="closeCase">✕</button>
        </div>
        <div class="meta">
          <span class="tc-status" :class="detail.status.toLowerCase()">{{ detail.status }}</span>
          <span class="chip">{{ detail.surface }}</span>
          <span class="chip">{{ detail.priority }}</span>
          <span class="chip">{{ detail.testType }}</span>
          <span v-if="detail.roles.length" class="chip">{{ detail.roles.join(', ') }}</span>
          <span v-if="detail.flowRef" class="faint small mono">{{ detail.flowRef.replace(/^knowledge\//, '') }}</span>
        </div>
        <p v-if="detail.precondition"><strong>Precondition.</strong> {{ detail.precondition }}</p>
        <ol class="steps">
          <li v-for="(s, i) in detail.steps" :key="i">
            <div class="pre-wrap">{{ s.action }}</div>
            <div v-if="s.expected" class="expected pre-wrap">→ {{ s.expected }}</div>
          </li>
        </ol>
        <p v-if="detail.tags" class="small faint">Tags: {{ detail.tags }}</p>

        <h3>Saved spec</h3>
        <div v-if="!detail.spec" class="faint small">None yet. A run whose test for this case passes saves its spec here.</div>
        <div v-else class="row spec-row">
          <span class="small">
            <RouterLink :to="`/templates/${detail.spec.templateId}`">Template #{{ detail.spec.templateId }}</RouterLink>
            from <RouterLink :to="`/runs/${detail.spec.runId}`">run #{{ detail.spec.runId }}</RouterLink>
            <span class="faint">· passed {{ fmtTime(detail.spec.savedAt) }} · test “{{ detail.spec.testTitle }}”</span>
          </span>
          <button class="btn" @click="router.push(`/runs/new?templateId=${detail.spec.templateId}`)">▶ Replay</button>
        </div>
        <h3>Last result</h3>
        <div v-if="!detail.last" class="faint small">Never run.</div>
        <div v-else class="row">
          <span class="badge" :class="resultClass(detail.last.status)">{{ detail.last.status }}</span>
          <span class="faint small">{{ detail.last.run }} · {{ detail.last.at }}</span>
        </div>
        <h3>qa-flow runs</h3>
        <div v-if="!detail.qaFlowRuns.length" class="faint small">None yet.</div>
        <ul v-else class="runs">
          <li v-for="r in detail.qaFlowRuns" :key="r.id">
            <StatusBadge :status="r.status" /> <RouterLink :to="`/runs/${r.id}`" class="small">#{{ r.id }} {{ r.name }}</RouterLink>
            <span class="faint small">{{ fmtTime(r.created_at) }}</span>
          </li>
        </ul>
        <details v-if="detail.sources.length" class="small">
          <summary class="muted">Where it came from ({{ detail.sources.length }})</summary>
          <ul class="sources">
            <li v-for="(s, i) in detail.sources" :key="i"><span class="faint">{{ s.kind }}</span> <span class="mono">{{ s.ref }}</span></li>
          </ul>
        </details>
        <div class="row" style="justify-content: flex-end; margin-top: 16px">
          <button class="btn" @click="selected.has(detail.code) ? selected.delete(detail.code) : selected.set(detail.code, detail)">
            {{ selected.has(detail.code) ? 'Unselect' : 'Select' }}
          </button>
          <button class="btn primary" :disabled="MOBILE.has(detail.surface)" :title="MOBILE.has(detail.surface) ? 'Mobile case: run it on a device' : ''" @click="runPicked([detail])">
            ✨ Run with AI
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page.wide { max-width: 1400px; }
.lib { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 16px; align-items: start; }
.tree { padding: 8px; max-height: calc(100vh - 190px); overflow-y: auto; position: sticky; top: 72px; }
.mod-head, .feat { display: flex; align-items: center; gap: 6px; width: 100%; background: none; border: 0; font: inherit; color: var(--text); text-align: left; cursor: pointer; border-radius: 6px; }
.mod-head { padding: 7px 8px; font-weight: 600; }
.mod-head:hover, .feat:hover { background: var(--surface-2); }
.caret { color: var(--faint); font-size: 11px; transition: transform 0.15s; width: 10px; }
.caret.on { transform: rotate(90deg); }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.tree ul { list-style: none; margin: 0 0 4px; padding: 0 0 0 16px; }
.feat { padding: 5px 8px; font-size: 13.5px; color: var(--muted); }
.feat.active { background: var(--accent-soft); color: var(--accent); }
.feat.active .count { color: var(--accent); }
.cases { min-width: 0; }
.toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.toolbar .q { flex: 1 1 260px; min-width: 0; }
.toolbar select { width: auto; flex: 0 0 auto; }
.chip.spec { margin-left: 6px; background: var(--pass-soft); color: var(--pass); }
.spec-row { justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.chip { display: inline-flex; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--muted); }
.heading { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
th.pick, td.pick { width: 28px; padding-right: 0; }
.code { color: var(--accent); }
.tc-status { font-size: 11px; font-weight: 700; letter-spacing: 0.03em; padding: 2px 7px; border-radius: 6px; background: var(--surface-2); color: var(--muted); }
.tc-status.active { background: var(--pass-soft); color: var(--pass); }
.tc-status.needs_review { background: var(--warn-soft); color: var(--warn); }
.pickbar { position: sticky; bottom: 16px; margin-top: 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; box-shadow: var(--shadow); border-color: var(--accent); }
.picked-codes { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal.case { max-width: 760px; width: 100%; max-height: 88vh; overflow-y: auto; }
.modal.case h2 { margin: 4px 0 0; font-size: 18px; }
.modal.case h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 18px 0 6px; }
.meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
.steps { padding-left: 22px; margin: 12px 0; }
.steps li { margin-bottom: 8px; }
.expected { color: var(--pass); margin-top: 2px; }
.pre-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.runs, .sources { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.sources { margin-top: 6px; overflow-wrap: anywhere; }
@media (max-width: 860px) {
  .lib { grid-template-columns: 1fr; }
  .tree { position: static; max-height: 300px; }
  .picked-codes { max-width: 100%; }
}
</style>
