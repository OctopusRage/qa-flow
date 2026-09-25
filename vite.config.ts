import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const api = `http://127.0.0.1:${process.env.PORT ?? 4777}`;

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5177, proxy: { '/api': api, '/files': api } },
});
