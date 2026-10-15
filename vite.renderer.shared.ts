// SPDX-License-Identifier: GPL-2.0-or-later
// Renderer build settings shared by the Electron build
// (electron.vite.config.ts) and the Tauri build (vite.tauri.config.ts), so
// both bundle the renderer with the same define values, plugins and target.

import { statSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

const TARGET = 'esnext'

export function rendererViteConfig() {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_TIME__: JSON.stringify(statSync('src/renderer/i18n/locales/english.json').mtime.toISOString()),
    },
    plugins: [react(), tailwindcss()],
    build: {
      target: TARGET,
    },
    esbuild: {
      target: TARGET,
    },
  }
}
