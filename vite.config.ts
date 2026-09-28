import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  resolve: {
    // @digitalcredentials/batch-issuer-ui is a linked (file:) package with
    // its own node_modules; without dedupe its externalized react import
    // resolves through the symlink to a SECOND React copy, and the panel
    // white-screens with an invalid-hook TypeError (null dispatcher).
    dedupe: ['react', 'react-dom', '@interop/was-client'],
  },
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
