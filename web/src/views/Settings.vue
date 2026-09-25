<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, errorText, toast, type Settings } from '../api';
import VarsEditor from '../components/VarsEditor.vue';

const s = ref<Settings | null>(null);
const slackToken = ref('');
const anthropicKey = ref('');
const saving = ref(false);
const slackCheck = ref('');
const slackError = ref('');

onMounted(async () => (s.value = await api<Settings>('/settings')));

async function save(extra: Record<string, unknown> = {}) {
  if (!s.value) return;
  saving.value = true;
  try {
    s.value = await api<Settings>('/settings', {
      method: 'PUT',
      body: {
        slackChannel: s.value.slackChannel,
        model: s.value.model,
        maxTurns: Number(s.value.maxTurns),
        headless: s.value.headless,
        workers: Number(s.value.workers),
        testTimeoutSec: Number(s.value.testTimeoutSec),
        variables: s.value.variables,
        baseUrls: s.value.baseUrls,
        slackToken: slackToken.value || undefined,
        anthropicApiKey: anthropicKey.value || undefined,
        ...extra,
      },
    });
    slackToken.value = '';
    anthropicKey.value = '';
    toast('Settings saved');
  } catch (e) {
    toast(errorText(e));
  } finally {
    saving.value = false;
  }
}

async function testSlack() {
  slackCheck.value = '';
  slackError.value = '';
  try {
    const r = await api<{ team: string; user: string }>('/settings/slack-test', { body: { token: slackToken.value || undefined } });
    slackCheck.value = `Connected to ${r.team} as ${r.user}`;
  } catch (e) {
    slackError.value = errorText(e);
  }
}

const removeUrl = (u: string) => s.value && (s.value.baseUrls = s.value.baseUrls.filter((x) => x !== u));
</script>

<template>
  <div v-if="s" class="page narrow">
    <div class="page-head">
      <div>
        <h1>Settings</h1>
        <p>Stored locally in <code>data/qa-flow.db</code> (owner-only file). Tokens are never sent back to the browser.</p>
      </div>
    </div>

    <form @submit.prevent="save()">
      <section class="card">
        <h2>Slack</h2>
        <label class="field">
          <span>Token</span>
          <input v-model="slackToken" type="password" autocomplete="off" :placeholder="s.slackTokenHint ? `Saved (${s.slackTokenHint}). Paste a new one to replace` : 'xoxp-… or xoxb-…'" />
          <small>
            A user token (xoxp) posts as you; a bot token (xoxb) needs <code>chat:write</code> and <code>files:write</code> and must be in the channel.
            <code>channels:read</code>/<code>groups:read</code> allow <code>#name</code> lookups.
          </small>
        </label>
        <div class="row" style="margin-bottom: 14px">
          <button class="btn small" type="button" @click="testSlack">Test connection</button>
          <button v-if="s.slackTokenHint" class="btn small ghost danger" type="button" @click="save({ clearSlackToken: true })">Remove token</button>
          <span v-if="slackCheck" class="small" style="color: var(--pass)">✓ {{ slackCheck }}</span>
          <span v-if="slackError" class="small" style="color: var(--fail)">{{ slackError }}</span>
        </div>
        <label class="field">
          <span>Default channel</span>
          <input v-model="s.slackChannel" type="text" placeholder="C0123ABCD or #qa-reports" />
        </label>
      </section>

      <section class="card">
        <h2>Shared variables</h2>
        <p class="muted small" style="margin-top: -6px">
          Available to every flow as <code>v('KEY')</code>. Mark credentials as secret: the AI only sees the key name, never the value.
        </p>
        <VarsEditor v-model="s.variables" allow-secret />
      </section>

      <section class="card">
        <h2>AI generation</h2>
        <div class="grid cols-2">
          <label class="field">
            <span>Model</span>
            <input v-model="s.model" type="text" placeholder="Default (your Claude Code model)" list="models" />
            <datalist id="models"><option value="claude-opus-5-5" /><option value="claude-sonnet-5" /><option value="claude-haiku-4-5-20251001" /></datalist>
          </label>
          <label class="field">
            <span>Max agent turns</span>
            <input v-model="s.maxTurns" type="number" min="10" max="400" />
          </label>
        </div>
        <label class="field">
          <span>Anthropic API key (optional)</span>
          <input v-model="anthropicKey" type="password" autocomplete="off" :placeholder="s.anthropicApiKeyHint ? `Saved (${s.anthropicApiKeyHint})` : 'Blank = use your Claude Code login'" />
          <small v-if="s.anthropicApiKeyHint"><a href="#" @click.prevent="save({ clearAnthropicApiKey: true })">Remove key</a></small>
        </label>
      </section>

      <section class="card">
        <h2>Playwright</h2>
        <div class="grid cols-2">
          <label class="field"><span>Test timeout (seconds)</span><input v-model="s.testTimeoutSec" type="number" min="10" /></label>
          <label class="field"><span>Workers</span><input v-model="s.workers" type="number" min="1" max="8" /></label>
        </div>
        <label class="row"><input v-model="s.headless" type="checkbox" /> Headless browser <span class="muted small">(untick to watch runs in a visible window)</span></label>
        <div v-if="s.baseUrls.length" style="margin-top: 16px">
          <strong>Recent base URLs</strong>
          <ul class="urls">
            <li v-for="u in s.baseUrls" :key="u"><span class="mono small">{{ u }}</span><button class="btn small ghost danger" type="button" :aria-label="`Forget ${u}`" @click="removeUrl(u)">✕</button></li>
          </ul>
        </div>
      </section>

      <div class="row savebar">
        <button class="btn primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save settings' }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.narrow { max-width: 820px; }
.urls { list-style: none; padding: 0; margin: 8px 0 0; }
.urls li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; word-break: break-all; }
.savebar { position: sticky; bottom: 0; justify-content: flex-end; padding: 12px 0; background: linear-gradient(transparent, var(--bg) 40%); margin-top: 8px; }
</style>
