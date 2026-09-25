<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, errorText, type Run, type Settings, type Template, type Variable } from '../api';
import VarsEditor from '../components/VarsEditor.vue';

const route = useRoute();
const router = useRouter();

const mode = ref<'generate' | 'replay'>(route.query.mode === 'generate' || !route.query.templateId ? 'generate' : 'replay');
const templates = ref<Template[]>([]);
const settings = ref<Settings | null>(null);
const templateId = ref<number | null>(route.query.templateId ? Number(route.query.templateId) : null);
const name = ref('');
const baseUrl = ref('');
const instruction = ref('');
const variables = ref<Variable[]>([]);
const error = ref('');
const starting = ref(false);

const template = computed(() => templates.value.find((t) => t.id === templateId.value) ?? null);
const replayable = computed(() => templates.value.filter((t) => t.spec));

onMounted(async () => {
  [templates.value, settings.value] = await Promise.all([api<Template[]>('/templates'), api<Settings>('/settings')]);
  if (!baseUrl.value) baseUrl.value = template.value?.base_url || settings.value.baseUrls[0] || '';
  applyTemplate();
});

function applyTemplate() {
  const t = template.value;
  if (!t) return;
  name.value = t.name;
  baseUrl.value = t.base_url || baseUrl.value;
  instruction.value = t.instruction;
}
watch(templateId, applyTemplate);

async function start() {
  error.value = '';
  starting.value = true;
  try {
    const run = await api<Run>('/runs', {
      body: {
        mode: mode.value,
        templateId: templateId.value ?? undefined,
        name: name.value,
        baseUrl: baseUrl.value,
        instruction: instruction.value,
        variables: variables.value,
      },
    });
    router.push(`/runs/${run.id}`);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    starting.value = false;
  }
}

const globalKeys = computed(() => settings.value?.variables.map((v) => v.key) ?? []);
const templateKeys = computed(() => template.value?.variables.map((v) => v.key) ?? []);
</script>

<template>
  <div class="page narrow">
    <div class="page-head">
      <div>
        <h1>New run</h1>
        <p>Describe the scope and let the AI write and prove the flow, or replay a saved template.</p>
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button role="tab" :class="{ active: mode === 'generate' }" :aria-selected="mode === 'generate'" @click="mode = 'generate'">✨ Generate with AI</button>
      <button role="tab" :class="{ active: mode === 'replay' }" :aria-selected="mode === 'replay'" @click="mode = 'replay'">▶ Replay template</button>
    </div>

    <form class="card" @submit.prevent="start">
      <label v-if="mode === 'replay'" class="field">
        <span>Template</span>
        <select v-model="templateId" required>
          <option :value="null" disabled>Choose a template</option>
          <option v-for="t in replayable" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <small v-if="!replayable.length">No template has a saved spec yet. Generate one with AI first.</small>
      </label>

      <label v-else-if="templates.length" class="field">
        <span>Improve an existing template (optional)</span>
        <select v-model="templateId">
          <option :value="null">— New flow —</option>
          <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <small>The AI starts from the template's current spec and updates it (use this when the UI changed).</small>
      </label>

      <label v-if="mode === 'generate'" class="field">
        <span>Flow name</span>
        <input v-model="name" type="text" placeholder="Broadcast approval: admin approves a held broadcast" required />
      </label>

      <label class="field">
        <span>Base URL</span>
        <input v-model="baseUrl" type="url" list="base-urls" placeholder="https://qismo-stag4.qiscus.io/webui/" required />
        <datalist id="base-urls"><option v-for="u in settings?.baseUrls ?? []" :key="u" :value="u" /></datalist>
        <small>Specs navigate with relative paths, so the same flow runs against any environment.</small>
      </label>

      <label v-if="mode === 'generate'" class="field">
        <span>Test scope</span>
        <textarea
          v-model="instruction"
          rows="9"
          required
          placeholder="What should be tested, step by step, and what counts as a pass. E.g.
1. Log in as the admin (ADMIN_EMAIL / ADMIN_PASSWORD) at 'login'.
2. Open Settings › Agents Management, turn on 'Require approval before sending broadcast'.
3. Log in as the agent at '{APP_CODE}/login' in a second session and submit a broadcast.
4. As the admin, open Waiting Approval, approve it, and check the status becomes Sent.
Do not send to any number other than TEST_PHONE."
        ></textarea>
        <small>Reference variables by name; the AI uses them through <code>v('KEY')</code> and never sees secret values.</small>
      </label>

      <details class="vars-box">
        <summary><strong>Variables for this run</strong> <span class="muted small">(override Settings and template values)</span></summary>
        <p class="muted small">
          Available already:
          <template v-if="globalKeys.length || templateKeys.length">
            <code v-for="k in [...new Set([...globalKeys, ...templateKeys])]" :key="k" class="chip">{{ k }}</code>
          </template>
          <template v-else>none. Add shared credentials in <RouterLink to="/settings">Settings</RouterLink>.</template>
        </p>
        <VarsEditor v-model="variables" />
      </details>

      <p v-if="error" class="error-box">{{ error }}</p>
      <div class="row" style="justify-content: flex-end; margin-top: 16px">
        <button class="btn primary" type="submit" :disabled="starting">
          {{ starting ? 'Starting…' : mode === 'generate' ? '✨ Generate & run' : '▶ Run template' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.narrow { max-width: 820px; }
.vars-box { border: 1px dashed var(--border); border-radius: 8px; padding: 10px 12px; }
.vars-box summary { cursor: pointer; }
.chip { display: inline-block; background: var(--surface-2); border-radius: 6px; padding: 1px 6px; margin: 2px 4px 2px 0; }
</style>
