// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer build for the Tauri shell. Takes the renderer settings shared with
// the Electron build and swaps the HTML entry for tauri.html, whose entry
// module installs the vialAPI shim before loading the renderer.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { rendererViteConfig } from './vite.renderer.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RENDERER_ROOT = resolve(__dirname, 'src/renderer')
const DEV_PORT = 5173

const shared = rendererViteConfig()

// The root stays at src/renderer, as in the Electron build: Tailwind scans
// for class names under the Vite root.
export default defineConfig({
  ...shared,
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
