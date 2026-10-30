import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Consume shared zod schemas from source so web never depends on a shared build step.
  resolve: {
    alias: {
      '@fia/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  envDir: '..',
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
