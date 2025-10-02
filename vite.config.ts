// vite.config.ts
import { defineConfig } from 'vite';
// ...existing code...

export default defineConfig({
  // plugins: [], // No se usa React
  server: {
    proxy: {
      '/mcp-api': {
        target: 'https://cap-agent-flow.cfapps.us10-001.hana.ondemand.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mcp-api/, '/mcp'),
      },
    },
  },
});