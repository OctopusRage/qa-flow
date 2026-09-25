<script setup lang="ts">
import { toastText } from './api';

const nav = [
  { to: '/', label: 'Dashboard', exact: true },
  { to: '/runs', label: 'Runs', exact: true },
  { to: '/runs/new', label: 'New run' },
  { to: '/templates', label: 'Templates' },
  { to: '/settings', label: 'Settings' },
];
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <RouterLink to="/" class="brand">
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="22" height="22"><rect width="32" height="32" rx="8" fill="currentColor" /><path d="M9 17l4 4 10-10" stroke="white" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        QA Flow
      </RouterLink>
      <nav>
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" :exact-active-class="n.exact ? 'active' : ''" :active-class="n.exact ? '' : 'active'">{{ n.label }}</RouterLink>
      </nav>
    </header>
    <main><RouterView :key="$route.fullPath" /></main>
    <div v-if="toastText" class="toast" role="status">{{ toastText }}</div>
  </div>
</template>

<style scoped>
.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 24px; padding: 0 24px; height: 56px; background: var(--surface); border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 16px; color: var(--text); }
.brand:hover { text-decoration: none; }
.logo { color: var(--accent); display: flex; }
nav { display: flex; gap: 4px; overflow-x: auto; }
nav a { padding: 6px 12px; border-radius: 8px; color: var(--muted); font-weight: 550; white-space: nowrap; }
nav a:hover { background: var(--surface-2); text-decoration: none; }
nav a.active { background: var(--accent-soft); color: var(--accent); }
@media (max-width: 640px) {
  .topbar { padding: 0 16px; gap: 12px; }
  .brand { font-size: 0; gap: 0; }
}
</style>
