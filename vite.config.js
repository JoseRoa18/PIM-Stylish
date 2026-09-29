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
  // React/router and Supabase in their own chunks (performance pass
  // 2026-09-29): they rarely change, so after a deploy the browser keeps
  // them cached and only downloads the app's own code again. The patterns
  // are anchored on "node_modules/<name>/" — a looser one also caught
  // @tiptap/react and @pdfslick/react and put 1.15 MB on every page.
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/, priority: 20 },
            { name: 'vendor-supabase', test: /[\\/]node_modules[\\/](@supabase[\\/][^\\/]+|iceberg-js)[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
});