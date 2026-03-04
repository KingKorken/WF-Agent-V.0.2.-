import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: 5173,
  },
  optimizeDeps: {
    exclude: ['canvg', 'html2canvas', 'dompurify'],
  },
  build: {
    rollupOptions: {
      // jsPDF optional dependencies — not needed for text-only PDF generation
      external: ['canvg', 'html2canvas', 'dompurify'],
    },
  },
});
