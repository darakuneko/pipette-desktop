import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    esbuild: {
      target: 'esnext'
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    esbuild: {
      target: 'esnext'
    },
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      target: 'esnext'
    },
    esbuild: {
      target: 'esnext'
    }
  }
})
