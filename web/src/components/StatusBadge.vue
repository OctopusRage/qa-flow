<script setup lang="ts">
const props = defineProps<{ status: string }>();
const labels: Record<string, string> = { generating: 'AI generating', timedOut: 'timed out' };
</script>

<template>
  <span class="badge" :class="props.status">{{ labels[props.status] ?? props.status }}</span>
</template>
