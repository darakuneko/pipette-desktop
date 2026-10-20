// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer build for the Tauri shell. The HTML entry is tauri.html, whose
// entry module installs the vialAPI shim before loading the renderer.

import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { devServerHeaders } from './src/tauri-shim/csp-policy'
import pkg from './package.json'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_ROOT = resolve(__dirname, 'src/renderer')
const DEV_PORT = 5173
const TARGET = 'esnext'

// The root is src/renderer: Tailwind scans for class names under the Vite
// root.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(statSync('src/renderer/i18n/locales/english.json').mtime.toISOString()),
  },
  plugins: [react(), tailwindcss()],
  esbuild: {
    target: TARGET,
  },
  root: RENDERER_ROOT,
  base: './',
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    headers: devServerHeaders(),
  },
  build: {
    target: TARGET,
    outDir: resolve(__dirname, 'out-tauri/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(RENDERER_ROOT, 'tauri.html'),
    },
  },
})
