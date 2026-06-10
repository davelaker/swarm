import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Route all backend calls to the swarm server on :7000.
      // The server must be running (`swarm dev` in core/).
      // If the server is down, requests 404 and the UI falls back to mock mode.
      '/state':   { target: 'http://127.0.0.1:7000', changeOrigin: true },
      '/events':  { target: 'http://127.0.0.1:7000', changeOrigin: true },
      '/pm':      { target: 'http://127.0.0.1:7000', changeOrigin: true },
      '/run':     { target: 'http://127.0.0.1:7000', changeOrigin: true },
      '/context':  { target: 'http://127.0.0.1:7000', changeOrigin: true },
      '/findings': { target: 'http://127.0.0.1:7000', changeOrigin: true },
      '/fs':       { target: 'http://127.0.0.1:7000', changeOrigin: true },
      '/project':  { target: 'http://127.0.0.1:7000', changeOrigin: true },
    },
  },
})
