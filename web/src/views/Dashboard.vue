<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, fmtDuration, fmtTime, fmtTokens, fmtUsd, isLive, type QueueState, type Run, type SchedulerState, type Template, type UsageTotals } from '../api';
import StatusBadge from '../components/StatusBadge.vue';
import McpConnect from '../components/McpConnect.vue';
import RunnerPanel from '../components/RunnerPanel.vue';

type Dash = { templates: number; runs24h: number; passRate: number | null; costUsd: number; recent: Run[]; queue: QueueState; scheduler: SchedulerState; usage: { today: UsageTotals; last30d: UsageTotals; allTime: UsageTotals } };

const router = useRouter();
const dash = ref<Dash | null>(null);
const templates = ref<Template[]>([]);
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  [dash.value, templates.value] = await Promise.all([api<Dash>('/dashboard'), api<Template[]>('/templates')]);
}

async function quickRun(t: Template) {
  const run = await api<Run>('/runs', { body: { templateId: t.id } });
  router.push(`/runs/${run.id}`);
}

onMounted(() => {
  void load();
  // Poll while anything is in flight so statuses move without a reload.
  // Runs can also start from MCP clients, so keep polling: fast while something is in flight.
  let tick = 0;
  timer = setInterval(() => {
    tick += 1;
    const live = dash.value?.recent.some((r) => isLive(r.status));
    if (live || tick % 2 === 0) void load();
  }, 2500);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Dashboard</h1>
        <p>AI-written Playwright flows, replayed against any environment, with a screenshot for every step.</p>
      </div>
      <RouterLink to="/runs/new" class="btn primary">+ New run</RouterLink>
    </div>

    <div v-if="dash" class="grid cols-4">
      <div class="card stat"><div class="label">Templates</div><div class="value">{{ dash.templates }}</div></div>
      <div class="card stat"><div class="label">Runs, last 24h</div><div class="value">{{ dash.runs24h }}</div></div>
      <div class="card stat"><div class="label">Pass rate</div><div class="value">{{ dash.passRate === null ? '—' : `${dash.passRate}%` }}</div></div>
      <RouterLink to="/runs?range=30d" class="card stat usage" :title="`Today: ${fmtTokens(dash.usage.today.tokens)} tokens, ${fmtUsd(dash.usage.today.costUsd)} · All time: ${fmtTokens(dash.usage.allTime.tokens)} tokens, ${fmtUsd(dash.usage.allTime.costUsd)}`">
        <div class="label">AI tokens, 30 days</div>
        <div class="value">{{ fmtTokens(dash.usage.last30d.tokens) }}</div>
        <div class="faint small">{{ fmtUsd(dash.usage.last30d.costUsd) }} · today {{ fmtTokens(dash.usage.today.tokens) }}</div>
      </RouterLink>
    </div>

    <RunnerPanel v-if="dash" :state="dash.scheduler" />

    <McpConnect />

    <div class="grid cols-2" style="margin-top: 16px; align-items: start">
      <section class="card" style="grid-column: span 1">
        <div class="row" style="margin-bottom: 8px">
          <h2 style="margin: 0">Recent runs</h2>
          <span class="spacer" />
          <span v-if="dash?.queue.queued.length" class="muted small">{{ dash.queue.queued.length }} queued</span>
          <RouterLink to="/runs" class="small">All runs</RouterLink>
        </div>
        <div v-if="!dash?.recent.length" class="empty">
          No runs yet. <RouterLink to="/runs/new">Start one</RouterLink>: describe what to test and let the AI write the flow.
        </div>
        <div v-else class="table-wrap">
          <table class="list">
            <thead><tr><th>Run</th><th>Status</th><th>Result</th><th>When</th></tr></thead>
            <tbody>
              <tr v-for="r in dash.recent" :key="r.id" class="clickable" @click="router.push(`/runs/${r.id}`)">
                <td>
                  <div><strong>#{{ r.id }}</strong> {{ r.name }}</div>
                  <div class="faint small">
                    <span v-if="r.source === 'mcp'" class="src" title="Started by an AI tool over MCP">MCP</span>
                    {{ r.mode === 'generate' ? 'AI generate' : 'Replay' }} · {{ r.base_url }}
                  </div>
                </td>
                <td>
                  <StatusBadge :status="r.status" :title="dash.queue.waiting[r.id]" />
                  <div v-if="r.status === 'queued' && dash.queue.waiting[r.id]" class="faint small wait">{{ dash.queue.waiting[r.id] }}</div>
                </td>
                <td class="small">
                  <template v-if="r.summary">{{ r.summary.passed }}/{{ r.summary.total }} · {{ fmtDuration(r.summary.durationMs) }}</template>
                  <span v-else class="faint">—</span>
                </td>
                <td class="small muted">{{ fmtTime(r.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="card">
        <div class="row" style="margin-bottom: 8px">
          <h2 style="margin: 0">Flow templates</h2>
          <span class="spacer" />
          <RouterLink to="/templates" class="small">All templates</RouterLink>
        </div>
        <div v-if="!templates.length" class="empty">Save a passing AI run as a template to replay it in one click.</div>
        <ul v-else class="tpl-list">
          <li v-for="t in templates.slice(0, 8)" :key="t.id">
            <div class="grow">
              <RouterLink :to="`/templates/${t.id}`"><strong>{{ t.name }}</strong></RouterLink>
              <div class="faint small">
                <StatusBadge v-if="t.lastRun" :status="t.lastRun.status" style="margin-right: 6px" />
                {{ t.lastRun ? `last run ${fmtTime(t.lastRun.created_at)}` : 'never run' }}
              </div>
            </div>
            <button class="btn small" :disabled="!t.spec" :title="t.spec ? 'Replay the saved spec' : 'No spec yet'" @click="quickRun(t)">▶ Run</button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.usage { color: inherit; }
.usage:hover { text-decoration: none; border-color: var(--accent); }
.wait { max-width: 180px; margin-top: 2px; line-height: 1.3; }
.src { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; padding: 0 6px; border-radius: 4px; background: var(--accent-soft); color: var(--accent); margin-right: 4px; }
.tpl-list { list-style: none; margin: 0; padding: 0; }
.tpl-list li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.tpl-list li:last-child { border-bottom: 0; }
.grow { flex: 1; min-width: 0; }
</style>
