// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react'; // Asumiendo que usas React

export default defineConfig({
  plugins: [react()], // Asumiendo que usas React
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