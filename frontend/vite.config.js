import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// host: true permite exponer el servidor en la red local
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173
  }
})