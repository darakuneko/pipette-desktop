import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { rendererViteConfig } from './vite.renderer.shared'

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
  renderer: rendererViteConfig()
})
