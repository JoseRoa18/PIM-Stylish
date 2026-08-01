import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src'),
    },
  },
  // Pre-bundle the PDF viewer so its (lazy) first import doesn't trigger an
  // on-demand dep re-optimization + page reload in dev, which closes the
  // preview modal before the PDF can render.
  optimizeDeps: {
    include: ['@pdfslick/react', 'pdfjs-dist'],
  },
});