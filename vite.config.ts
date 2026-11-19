import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      // chapi.html is the CHAPI credential-handler window (see manifest.json)
      input: {
        main: 'index.html',
        chapi: 'chapi.html',
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
})
