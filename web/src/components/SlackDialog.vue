<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, errorText, fileUrl, toast } from '../api';

type DraftImage = { path: string; title: string; step: string; test: string; status: string; selected: boolean };
const props = defineProps<{ runId: number }>();
const emit = defineEmits<{ close: []; posted: [permalink?: string] }>();

const loading = ref(true);
const posting = ref(false);
const error = ref('');
const text = ref('');
const channel = ref('');
const thread = ref('');
const tokenSet = ref(true);
const images = ref<DraftImage[]>([]);
const selectedCount = computed(() => images.value.filter((i) => i.selected).length);

onMounted(async () => {
  try {
    const d = await api<{ text: string; images: DraftImage[]; channel: string; tokenSet: boolean }>(`/runs/${props.runId}/slack-draft`);
    text.value = d.text;
    images.value = d.images;
    channel.value = d.channel;
    tokenSet.value = d.tokenSet;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
});

const setAll = (on: boolean) => images.value.forEach((i) => (i.selected = on));

async function post() {
  posting.value = true;
  error.value = '';
  try {
    const r = await api<{ permalink?: string }>(`/runs/${props.runId}/slack`, {
      body: { channel: channel.value, thread: thread.value, text: text.value, images: images.value.filter((i) => i.selected).map((i) => i.path) },
    });
    toast('Posted to Slack');
    emit('posted', r.permalink);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    posting.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="slack-title">
      <div class="modal-head">
        <h2 id="slack-title" style="margin: 0">Post report to Slack</h2>
        <button class="btn small ghost" aria-label="Close" @click="emit('close')">✕</button>
      </div>
      <div v-if="loading" class="empty">Preparing the report…</div>
      <template v-else>
        <p v-if="!tokenSet" class="notice">No Slack token yet. <RouterLink to="/settings">Add one in Settings</RouterLink> first.</p>
        <div class="grid cols-2">
          <label class="field">
            <span>Channel</span>
            <input v-model="channel" type="text" placeholder="C0123ABCD or #qa-reports" />
          </label>
          <label class="field">
            <span>Thread (optional)</span>
            <input v-model="thread" type="text" placeholder="Paste a message link or thread ts" />
            <small>A message link also sets the channel.</small>
          </label>
        </div>
        <label class="field">
          <span>Message</span>
          <textarea v-model="text" rows="10" class="mono"></textarea>
          <small>Slack formatting: *bold*, _italic_, `code`, &lt;@U123&gt; mentions.</small>
        </label>
        <div class="row" style="margin-bottom: 8px">
          <strong>Screenshots</strong>
          <span class="muted small">{{ selectedCount }} of {{ images.length }} selected{{ selectedCount > 10 ? ' · posts in batches of 10' : '' }}</span>
          <span class="spacer" />
          <button class="btn small" type="button" @click="setAll(true)">All</button>
          <button class="btn small" type="button" @click="setAll(false)">None</button>
        </div>
        <div v-if="images.length" class="shots">
          <label v-for="img in images" :key="img.path" class="shot" :class="{ on: img.selected, failed: img.status === 'failed' }" :title="img.title">
            <input v-model="img.selected" type="checkbox" />
            <img :src="fileUrl(runId, img.path)" :alt="img.title" loading="lazy" />
            <span>{{ img.step }}</span>
          </label>
        </div>
        <p v-else class="muted">This run has no step screenshots.</p>
        <p v-if="error" class="error-box">{{ error }}</p>
        <div class="row" style="margin-top: 16px; justify-content: flex-end">
          <button class="btn" @click="emit('close')">Cancel</button>
          <button class="btn primary" :disabled="posting || !tokenSet || !text.trim()" @click="post">{{ posting ? 'Posting…' : 'Post to Slack' }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; max-height: 320px; overflow: auto; padding: 2px; }
.shot { position: relative; display: flex; flex-direction: column; gap: 4px; border: 2px solid var(--border); border-radius: 8px; padding: 6px; cursor: pointer; font-size: 11.5px; color: var(--muted); }
.shot.on { border-color: var(--accent); }
.shot.failed span { color: var(--fail); }
.shot input { position: absolute; top: 10px; left: 10px; }
.shot img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; border-radius: 4px; background: var(--surface-2); }
.shot span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
