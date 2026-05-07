import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Repo root (parent of admin-ui/). Used so `npm --prefix admin-ui run dev`
 * picks up UNSUB_PORT from the main app's .env instead of silently proxying to 3000.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const unsubPort =
    typeof env.UNSUB_PORT === 'string' && /^[0-9]+$/.test(env.UNSUB_PORT.trim())
      ? env.UNSUB_PORT.trim()
      : '3000';
  const target = `http://127.0.0.1:${unsubPort}`;

  return {
    plugins: [react()],
    base: '/admin/',
    build: {
      outDir: '../dist/admin',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true },
      },
    },
  };
});
