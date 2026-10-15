// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer build for the Tauri shell. Takes the renderer settings shared with
// the Electron build and swaps the HTML entry for tauri.html, whose entry
// module installs the vialAPI shim before loading the renderer.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import { rendererViteConfig } from './vite.renderer.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_ROOT = resolve(__dirname, 'src/renderer')
const DEV_PORT = 5173

const ELECTRON_HID_TRANSPORT = resolve(__dirname, 'src/preload/hid-transport.ts')
const TAURI_HID_TRANSPORT = resolve(__dirname, 'src/tauri-shim/hid-transport.ts')

const shared = rendererViteConfig()

/** src/preload/protocol.ts runs in the WebView as is; its import of the
 *  Electron transport (ipcRenderer) is served by the Tauri one, which has the
 *  same exports. */
function tauriHidTransport(): Plugin {
  return {
    name: 'pipette-tauri-hid-transport',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      return resolved?.id === ELECTRON_HID_TRANSPORT ? TAURI_HID_TRANSPORT : null
    },
  }
}

// The root stays at src/renderer, as in the Electron build: Tailwind scans
// for class names under the Vite root.
export default defineConfig({
  ...shared,
  plugins: [tauriHidTransport(), ...shared.plugins],
  root: RENDERER_ROOT,
  base: './',
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    ...shared.build,
    outDir: resolve(__dirname, 'out/renderer-tauri'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(RENDERER_ROOT, 'tauri.html'),
    },
  },
})
