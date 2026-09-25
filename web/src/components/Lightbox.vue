<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

export type Shot = { src: string; caption: string; status?: string };
const props = defineProps<{ shots: Shot[] }>();
const index = defineModel<number | null>({ required: true });

const move = (d: number) => {
  if (index.value === null) return;
  index.value = (index.value + d + props.shots.length) % props.shots.length;
};
const onKey = (e: KeyboardEvent) => {
  if (index.value === null) return;
  if (e.key === 'Escape') index.value = null;
  if (e.key === 'ArrowRight') move(1);
  if (e.key === 'ArrowLeft') move(-1);
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div v-if="index !== null && props.shots[index]" class="lb" role="dialog" aria-modal="true" @click.self="index = null">
    <figure>
      <img :src="props.shots[index].src" :alt="props.shots[index].caption" />
      <figcaption>
        <span class="badge" :class="props.shots[index].status">{{ index + 1 }} / {{ props.shots.length }}</span>
        {{ props.shots[index].caption }}
      </figcaption>
    </figure>
    <button class="nav prev" aria-label="Previous" @click="move(-1)">‹</button>
    <button class="nav next" aria-label="Next" @click="move(1)">›</button>
    <button class="close" aria-label="Close" @click="index = null">✕</button>
  </div>
</template>

<style scoped>
.lb { position: fixed; inset: 0; background: rgb(0 0 0 / 88%); z-index: 60; display: grid; place-items: center; padding: 48px 56px; }
figure { margin: 0; max-width: 100%; max-height: 100%; display: flex; flex-direction: column; gap: 10px; align-items: center; }
img { max-width: 100%; max-height: calc(100vh - 140px); border-radius: 6px; background: #fff; }
figcaption { color: #eee; display: flex; gap: 10px; align-items: center; }
.nav, .close { position: absolute; background: rgb(255 255 255 / 12%); color: #fff; border: 0; border-radius: 50%; width: 42px; height: 42px; font-size: 24px; cursor: pointer; }
.prev { left: 8px; top: 50%; }
.next { right: 8px; top: 50%; }
.close { top: 10px; right: 10px; font-size: 16px; }
@media (max-width: 640px) { .lb { padding: 48px 8px; } }
</style>
