// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer build for the Tauri shell. Takes the renderer settings shared with
// the Electron build and adds the vialAPI shim as a module script that runs
// before the renderer entry.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { rendererViteConfig } from './vite.renderer.shared'

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

const shared = rendererViteConfig()

export default defineConfig({
  ...shared,
  root: RENDERER_ROOT,
  base: './',
  clearScreen: false,
  plugins: [injectVialApiShim(), ...shared.plugins],
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    ...shared.build,
    outDir: resolve(__dirname, 'out/renderer-tauri'),
    emptyOutDir: true,
  },
})
