import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Stub module for jsPDF optional dependencies that aren't needed for text-only PDFs.
// Returns an empty module so Vite's import analysis doesn't error in dev mode.
const jspdfOptionalStub = path.resolve(__dirname, 'src/stubs/jspdf-optional.ts');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      // Stub out jsPDF optional deps — prevents Vite dev import analysis errors
      canvg: jspdfOptionalStub,
      html2canvas: jspdfOptionalStub,
      dompurify: jspdfOptionalStub,
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
