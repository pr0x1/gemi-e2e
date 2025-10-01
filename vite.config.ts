import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/mcp-proxy': {
        target: 'https://cap-agent-flow.cfapps.us10-001.hana.ondemand.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mcp-proxy/, ''),
      },
    },
  },
});
