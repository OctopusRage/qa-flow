import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const api = `http://127.0.0.1:${process.env.PORT ?? 4777}`;

// Built assets are referenced relatively, so the same build works at the root
// (http://127.0.0.1:4777/) and behind a reverse proxy under a sub-path. The
// server injects <base href> for the prefix — see servePage() in server/index.ts.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  root: 'web',
  plugins: [vue()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5177, proxy: { '/api': api, '/files': api } },
}));
