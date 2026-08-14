import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: dir,
  plugins: [react()],
  build: {
    outDir: path.join(dir, 'dist'),
    emptyOutDir: true,
  },
  server: {
    // 5173 is already taken by another project on this machine.
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8090',
      '/health': 'http://localhost:8090',
    },
  },
});
