<script setup lang="ts">
import type { Variable } from '../api';

const props = defineProps<{ allowSecret?: boolean; placeholderHint?: string }>();
const model = defineModel<Variable[]>({ required: true });

const add = () => model.value.push({ key: '', value: '', secret: false });
const remove = (i: number) => model.value.splice(i, 1);
</script>

<template>
  <div class="vars">
    <div v-for="(v, i) in model" :key="i" class="var-row">
      <input v-model="v.key" type="text" placeholder="KEY" class="mono key" aria-label="Variable name" />
      <input
        v-model="v.value"
        :type="v.secret ? 'password' : 'text'"
        :placeholder="v.secret && v.isSet ? '•••••• saved (leave blank to keep)' : (props.placeholderHint ?? 'value')"
        aria-label="Variable value"
        autocomplete="off"
      />
      <label v-if="props.allowSecret" class="secret"><input v-model="v.secret" type="checkbox" /> secret</label>
      <button class="btn small ghost danger" type="button" aria-label="Remove variable" @click="remove(i)">✕</button>
    </div>
    <button class="btn small" type="button" @click="add">+ Add variable</button>
  </div>
</template>

<style scoped>
.var-row { display: grid; grid-template-columns: minmax(120px, 220px) 1fr auto auto; gap: 8px; align-items: center; margin-bottom: 8px; }
.key { text-transform: uppercase; }
.secret { display: flex; gap: 4px; align-items: center; color: var(--muted); font-size: 13px; white-space: nowrap; }
@media (max-width: 640px) {
  .var-row { grid-template-columns: 1fr auto; }
  .var-row > input:nth-child(2) { grid-column: 1 / -1; grid-row: 2; }
}
</style>
