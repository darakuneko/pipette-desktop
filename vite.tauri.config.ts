// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer build for the Tauri shell. Mirrors the renderer section of
// electron.vite.config.ts (same define values and plugins) and adds the
// vialAPI shim as a module script that runs before the renderer entry.

import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_ROOT = resolve(__dirname, 'src/renderer')
const SHIM_ENTRY = resolve(__dirname, 'src/tauri-shim/install.ts')
const DEV_PORT = 5173

/** Module scripts evaluate in document order, so the shim placed first in
 *  <head> installs window.vialAPI before src/renderer/index.tsx runs. */
function injectVialApiShim(): Plugin {
  return {
    name: 'pipette-inject-vialapi-shim',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        {
          tag: 'script',
          attrs: { type: 'module', src: `/@fs${SHIM_ENTRY}` },
          injectTo: 'head-prepend',
        },
      ],
    },
  }
}

export default defineConfig({
  root: RENDERER_ROOT,
  base: './',
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(statSync('src/renderer/i18n/locales/english.json').mtime.toISOString()),
  },
  plugins: [injectVialApiShim(), react(), tailwindcss()],
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: resolve(__dirname, 'out/renderer-tauri'),
    emptyOutDir: true,
  },
  esbuild: {
    target: 'esnext',
  },
})
