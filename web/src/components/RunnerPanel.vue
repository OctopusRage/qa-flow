<script setup lang="ts">
import { computed } from 'vue';
import type { SchedulerState } from '../api';

const props = defineProps<{ state: SchedulerState }>();

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const memUsedPct = computed(() => Math.round(100 * (1 - props.state.resources.memAvailable / props.state.resources.memTotal)));
const level = (pct: number, limit: number) => (pct >= limit ? 'hot' : pct >= limit * 0.75 ? 'warm' : 'ok');
const slots = computed(() => Array.from({ length: Math.max(1, props.state.maxConcurrent) }, (_, i) => props.state.running[i] ?? null));
</script>

<template>
  <section class="card runner">
    <div class="row head">
      <h2 style="margin: 0">Runner</h2>
      <span class="badge" :class="state.mode === 'auto' ? 'running' : ''" :title="state.mode === 'auto' ? 'Starts more runs only while CPU and memory allow' : 'Always runs up to the slot limit'">
        {{ state.mode === 'auto' ? 'Auto concurrency' : 'Fixed concurrency' }}
      </span>
      <span class="spacer" />
      <RouterLink to="/settings#concurrency" class="small">Configure</RouterLink>
    </div>

    <div class="meters">
      <div class="meter">
        <div class="row"><span class="muted small grow">CPU · {{ state.resources.cores }} cores</span><strong>{{ state.resources.cpuPercent }}%</strong></div>
        <div class="bar"><div :class="level(state.resources.cpuPercent, state.cpuLimitPercent)" :style="{ width: `${state.resources.cpuPercent}%` }" /><i :style="{ left: `${state.cpuLimitPercent}%` }" title="Auto limit" /></div>
      </div>
      <div class="meter">
        <div class="row"><span class="muted small grow">Memory · {{ gb(state.resources.memAvailable) }} free of {{ gb(state.resources.memTotal) }}</span><strong>{{ memUsedPct }}%</strong></div>
        <div class="bar"><div :class="level(memUsedPct, 100 - (state.memoryHeadroomMb * 1024 * 1024 * 100) / state.resources.memTotal)" :style="{ width: `${memUsedPct}%` }" /></div>
      </div>
    </div>

    <div class="slots" :aria-label="`${state.running.length} of ${state.maxConcurrent} run slots in use`">
      <span class="muted small">Slots</span>
      <RouterLink v-for="(s, i) in slots" :key="i" :to="s ? `/runs/${s.runId}` : ''" class="slot" :class="{ busy: s }" :title="s ? `Run #${s.runId} (${s.mode})` : 'Free'">
        {{ s ? `#${s.runId}` : '' }}
      </RouterLink>
      <span class="muted small">{{ state.running.length }}/{{ state.maxConcurrent }} running</span>
    </div>

    <ul v-if="state.queued.length" class="queued">
      <li v-for="q in state.queued" :key="q.runId">
        <RouterLink :to="`/runs/${q.runId}`">#{{ q.runId }}</RouterLink>
        <span class="muted small">⏳ {{ q.reason }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.runner { margin-top: 16px; }
.head { margin-bottom: 12px; }
.grow { flex: 1; min-width: 0; }
.meters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.bar { position: relative; height: 8px; border-radius: 999px; background: var(--surface-2); overflow: visible; margin-top: 4px; }
.bar > div { height: 100%; border-radius: 999px; transition: width 0.6s ease; }
.bar > div.ok { background: var(--pass); }
.bar > div.warm { background: var(--warn); }
.bar > div.hot { background: var(--fail); }
.bar > i { position: absolute; top: -3px; width: 2px; height: 14px; background: var(--faint); }
.slots { display: flex; align-items: center; gap: 6px; margin-top: 14px; flex-wrap: wrap; }
.slot { min-width: 44px; height: 26px; border-radius: 6px; border: 1px dashed var(--border); display: inline-grid; place-items: center; font-size: 12px; font-weight: 600; color: var(--info); pointer-events: none; }
.slot.busy { border-style: solid; background: var(--info-soft); border-color: transparent; pointer-events: auto; }
.queued { list-style: none; margin: 12px 0 0; padding: 10px 0 0; border-top: 1px solid var(--border); }
.queued li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
@media (max-width: 640px) { .meters { grid-template-columns: minmax(0, 1fr); } }
</style>
