<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorText, fmtDuration, fmtTime, toast, type Run, type Template, type Variable } from '../api';
import StatusBadge from '../components/StatusBadge.vue';
import VarsEditor from '../components/VarsEditor.vue';

const props = defineProps<{ id: string }>();
const router = useRouter();
const isNew = props.id === 'new';

const name = ref('');
const description = ref('');
const instruction = ref('');
const baseUrl = ref('');
const spec = ref('');
const variables = ref<Variable[]>([]);
const runs = ref<Run[]>([]);
const runUrl = ref('');
const saving = ref(false);
const error = ref('');
const loaded = ref(isNew);

onMounted(async () => {
  if (isNew) return;
  const t = await api<Template>(`/templates/${props.id}`);
  name.value = t.name;
  description.value = t.description;
  instruction.value = t.instruction;
  baseUrl.value = t.base_url;
  spec.value = t.spec;
  variables.value = t.variables;
  runs.value = t.runs ?? [];
  runUrl.value = t.base_url;
  loaded.value = true;
});

const body = () => ({ name: name.value, description: description.value, instruction: instruction.value, base_url: baseUrl.value, spec: spec.value, variables: variables.value });

async function save() {
  saving.value = true;
  error.value = '';
  try {
    const t = await api<Template>(isNew ? '/templates' : `/templates/${props.id}`, { method: isNew ? 'POST' : 'PUT', body: body() });
    toast('Template saved');
    if (isNew) router.replace(`/templates/${t.id}`);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    saving.value = false;
  }
}

async function runNow() {
  try {
    await save();
    const r = await api<Run>('/runs', { body: { templateId: Number(props.id), mode: 'replay', baseUrl: runUrl.value || baseUrl.value } });
    router.push(`/runs/${r.id}`);
  } catch (e) {
    toast(errorText(e));
  }
}

async function remove() {
  if (!confirm(`Delete template “${name.value}”? Its past runs are kept.`)) return;
  await api(`/templates/${props.id}`, { method: 'DELETE' });
  router.push('/templates');
}
</script>

<template>
  <div v-if="loaded" class="page">
    <div class="small muted" style="margin-bottom: 6px"><RouterLink to="/templates">Templates</RouterLink> › {{ isNew ? 'New' : name }}</div>
    <div class="page-head">
      <h1>{{ isNew ? 'New template' : name }}</h1>
      <div v-if="!isNew" class="row">
        <RouterLink class="btn" :to="{ path: '/runs/new', query: { templateId: props.id, mode: 'generate' } }" title="Let the AI update the spec, e.g. after a UI change">✨ Regenerate with AI</RouterLink>
        <button class="btn ghost danger" @click="remove">Delete</button>
      </div>
    </div>

    <div class="layout">
      <form class="card" @submit.prevent="save">
        <div class="grid cols-2">
          <label class="field"><span>Name</span><input v-model="name" type="text" required /></label>
          <label class="field"><span>Default base URL</span><input v-model="baseUrl" type="url" placeholder="https://…/webui/" /></label>
        </div>
        <label class="field"><span>Description</span><input v-model="description" type="text" placeholder="Optional" /></label>
        <label class="field">
          <span>Test scope</span>
          <textarea v-model="instruction" rows="6" placeholder="Used when the AI generates or regenerates the spec"></textarea>
        </label>
        <label class="field">
          <span>Template variables</span>
          <small style="margin: 0 0 8px">Non-secret defaults (app code, phone, IDs). Keep passwords in Settings as secrets.</small>
        </label>
        <VarsEditor v-model="variables" />
        <label class="field" style="margin-top: 16px">
          <span>Spec (flow.spec.ts)</span>
          <textarea v-model="spec" class="code" wrap="off" spellcheck="false" placeholder="import { test, expect, v } from './qa';"></textarea>
          <small>Wrap each action in <code>qa.step('title', async () =&gt; …)</code>; every step gets a screenshot.</small>
        </label>
        <p v-if="error" class="error-box">{{ error }}</p>
        <div class="row" style="justify-content: flex-end"><button class="btn primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save template' }}</button></div>
      </form>

      <aside v-if="!isNew">
        <div class="card">
          <h2>Run</h2>
          <label class="field">
            <span>Base URL</span>
            <input v-model="runUrl" type="url" />
          </label>
          <button class="btn primary" style="width: 100%" :disabled="!spec" @click="runNow">▶ Save & run</button>
          <p v-if="!spec" class="muted small">No spec yet: use Regenerate with AI.</p>
        </div>
        <div class="card">
          <div class="row" style="margin-bottom: 12px"><h2 style="margin: 0">History</h2><span class="spacer" /><RouterLink :to="`/runs?templateId=${props.id}`" class="small">Filter by date</RouterLink></div>
          <p v-if="!runs.length" class="muted small">No runs yet.</p>
          <ul class="history">
            <li v-for="r in runs" :key="r.id">
              <RouterLink :to="`/runs/${r.id}`">#{{ r.id }}</RouterLink>
              <StatusBadge :status="r.status" />
              <span class="muted small">{{ r.summary ? `${r.summary.passed}/${r.summary.total} · ${fmtDuration(r.summary.durationMs)}` : r.mode }}</span>
              <span class="faint small spacer" style="text-align: right">{{ fmtTime(r.created_at) }}</span>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
aside .card + .card { margin-top: 16px; }
.history { list-style: none; margin: 0; padding: 0; }
.history li { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); }
.history li:last-child { border-bottom: 0; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>
