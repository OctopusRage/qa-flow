<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorText, fmtTime, toast, type Run, type Template } from '../api';
import StatusBadge from '../components/StatusBadge.vue';

const router = useRouter();
const templates = ref<Template[] | null>(null);

onMounted(async () => (templates.value = await api<Template[]>('/templates')));

async function run(t: Template) {
  try {
    const r = await api<Run>('/runs', { body: { templateId: t.id } });
    router.push(`/runs/${r.id}`);
  } catch (e) {
    toast(errorText(e));
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Flow templates</h1>
        <p>Saved flows: a scope, a default base URL and a proven Playwright spec that replays without AI.</p>
      </div>
      <div class="row">
        <RouterLink to="/templates/new" class="btn">+ Blank template</RouterLink>
        <RouterLink to="/runs/new" class="btn primary">✨ Generate with AI</RouterLink>
      </div>
    </div>
    <div class="card">
      <div v-if="templates && !templates.length" class="empty">No templates yet. Generate a flow with AI, then save the passing run as a template.</div>
      <div v-else class="table-wrap">
        <table class="list">
          <thead><tr><th>Template</th><th>Default base URL</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            <tr v-for="t in templates ?? []" :key="t.id" class="clickable" @click="router.push(`/templates/${t.id}`)">
              <td>
                <strong>{{ t.name }}</strong>
                <div class="faint small">{{ t.description || t.instruction.split('\n')[0] || '—' }}</div>
              </td>
              <td class="mono small">{{ t.base_url || '—' }}</td>
              <td>
                <template v-if="t.lastRun"><StatusBadge :status="t.lastRun.status" /> <span class="muted small">{{ fmtTime(t.lastRun.created_at) }}</span></template>
                <span v-else class="faint small">never</span>
              </td>
              <td style="text-align: right">
                <button class="btn small" :disabled="!t.spec" :title="t.spec ? 'Replay now' : 'No spec yet'" @click.stop="run(t)">▶ Run</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
