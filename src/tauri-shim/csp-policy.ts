// SPDX-License-Identifier: GPL-2.0-or-later
// The Tauri window's CSP: the Electron policy of src/main/csp.ts plus the
// sources Tauri's IPC needs. src-tauri/tauri.conf.json carries it for the
// bundled pages (tauri-csp.test.ts checks the two match). Tauri gives the
// pages of the Vite dev server no CSP, so vite.tauri.config.ts sends
// `devServerHeaders` from the dev server itself.

import { buildCsp, securityHeaders } from '../main/csp'

/** Tauri's IPC: the custom protocol and its http fallback on Linux/Windows. */
export const TAURI_IPC_SOURCES: Readonly<Record<string, readonly string[]>> = {
  'connect-src': ['ipc:', 'http://ipc.localhost'],
}

/** The Electron policy with `TAURI_IPC_SOURCES` added to its directives. */
export function tauriCsp(isDev: boolean): string {
  return buildCsp(isDev)
    .split('; ')
    .map((directive) => {
      const name = directive.split(' ')[0]
      const extra = TAURI_IPC_SOURCES[name]
      return extra ? [directive, ...extra].join(' ') : directive
    })
    .join('; ')
}

/** The headers of the dev server's responses: the Electron build's, with the
 *  dev policy. */
export function devServerHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': tauriCsp(true),
    ...Object.fromEntries(Object.entries(securityHeaders).map(([name, values]) => [name, values.join(', ')])),
  }
}
