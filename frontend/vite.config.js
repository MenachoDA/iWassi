import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // Redirige las peticiones de la API al backend automáticamente
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Redirige el tráfico de WebSockets (Socket.IO) al backend
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      }
    }
  }
})