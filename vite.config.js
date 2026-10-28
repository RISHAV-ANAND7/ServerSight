import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    preserveSymlinks: true
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4000', ws: true },
      '/api': 'http://127.0.0.1:4000'
    }
  }
});
