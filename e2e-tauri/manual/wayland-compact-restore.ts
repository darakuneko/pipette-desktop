// SPDX-License-Identifier: GPL-2.0-or-later
//
// Checks on GNOME's Wayland compositor that leaving the Typing View's
// compact mode gives the window back the size it had before entering:
// GTK draws client-side decorations there, and the window grows by them
// when the size the app keeps and the size it sets back are not the same
// measure. Not part of the e2e suite (the suite runs on Xvfb, where GTK
// draws none); run by hand on Linux after `pnpm build:debug`:
//
//   npx tsx e2e-tauri/manual/wayland-compact-restore.ts
//
// It runs its own headless mutter (Wayland only, no Xwayland) on a fresh
// socket name, on a private D-Bus session bus, with in-memory GSettings, a
// temporary XDG config directory and a temporary userData directory, so the
// desktop session is never touched. It needs mutter, dbus-run-session and
// tauri-driver (with WebKitWebDriver). The window opens at 1547x1024, enters
// and leaves compact mode twice, and the page's viewport (the content size
// at zoom 1) is compared with the one it opened with. Exits 1 when they
// differ.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_BINARY, appEnv } from '../helpers/driver'
import { assertDevToolsBinary } from '../helpers/hub-env'

const SIZE = { width: 1547, height: 1024 }
const COMPACT = { width: 400, height: 157 }
const MONITOR = '1920x1200'
const TIMEOUT_S = 120
const STEP_SETTLE_MS = 1_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

async function main(): Promise<number> {
  assertDevToolsBinary(APP_BINARY)
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (!runtimeDir) throw new Error('XDG_RUNTIME_DIR is not set')
  const socket = `pipette-compact-check-${process.pid}`
  const ours = [join(runtimeDir, socket), join(runtimeDir, `${socket}.lock`)]
  if (ours.some(existsSync)) throw new Error(`${socket} exists already`)
  const userData = mkdtempSync(join(tmpdir(), 'pipette-compact-check-'))
  const configHome = mkdtempSync(join(tmpdir(), 'pipette-compact-check-xdg-'))
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ windowState: { x: 0, y: 0, ...SIZE } }))
  const [port, nativePort] = [await freePort(), await freePort()]
  const env: NodeJS.ProcessEnv = {
    ...appEnv(userData, {}),
    GSETTINGS_BACKEND: 'memory',
    GIO_USE_VFS: 'local',
    NO_AT_BRIDGE: '1',
    XDG_CONFIG_HOME: configHome,
  }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const compositor = spawn(
    'timeout',
    ['-k', '5', String(TIMEOUT_S), 'dbus-run-session', '--', 'mutter', '--headless', '--wayland', '--no-x11',
      `--wayland-display=${socket}`, '--virtual-monitor', MONITOR, '--',
      'env', `WAYLAND_DISPLAY=${socket}`, 'GDK_BACKEND=wayland',
      'tauri-driver', '--port', String(port), '--native-port', String(nativePort)],
    { env, stdio: ['ignore', 'ignore', 'ignore'], detached: true },
  )
  const base = `http://127.0.0.1:${port}`
  const webdriver = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await response.json()) as { value: T }
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`)
    return json.value
  }
  let sessionId: string | undefined
  try {
    for (let tries = 0; ; tries++) {
      if (await fetch(`${base}/status`).then(() => true, () => false)) break
      if (tries > 100) throw new Error('tauri-driver did not start in the compositor')
      await sleep(200)
    }
    sessionId = (await webdriver<{ sessionId: string }>('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application: APP_BINARY } } },
    })).sessionId
    const execute = <T>(script: string): Promise<T> =>
      webdriver<T>('POST', `/session/${sessionId}/execute/sync`, { script, args: [] })
    const setCompactMode = (args: Record<string, unknown>): Promise<unknown> =>
      webdriver('POST', `/session/${sessionId}/execute/async`, {
        script: 'const done = arguments[arguments.length - 1];'
          + 'window.__TAURI_INTERNALS__.invoke("set_window_compact_mode", arguments[0]).then(done, (e) => done(String(e)))',
        args: [args],
      })
    const viewport = (): Promise<[number, number]> => execute('return [window.innerWidth, window.innerHeight]')
    for (let tries = 0; !(await execute<boolean>('return typeof window.vialAPI === "object"')); tries++) {
      if (tries > 100) throw new Error('the page did not load')
      await sleep(200)
    }
    await sleep(STEP_SETTLE_MS)
    const opened = await viewport()
    console.log(`opened: ${opened.join('x')}`)
    let failed = opened[0] !== SIZE.width || opened[1] !== SIZE.height
    for (const round of [1, 2]) {
      await setCompactMode({ enabled: true, compactSize: COMPACT })
      await sleep(STEP_SETTLE_MS)
      console.log(`compact #${round}: ${(await viewport()).join('x')}`)
      const answer = await setCompactMode({ enabled: false })
      await sleep(STEP_SETTLE_MS)
      const left = await viewport()
      console.log(`left #${round}: ${left.join('x')} (leaving answered ${JSON.stringify(answer)})`)
      if (left[0] !== opened[0] || left[1] !== opened[1]) failed = true
    }
    console.log(failed ? 'FAIL: the window did not come back at its size' : 'OK')
    return failed ? 1 : 0
  } finally {
    if (sessionId) await webdriver('DELETE', `/session/${sessionId}`).catch(() => undefined)
    if (compositor.pid !== undefined && compositor.exitCode === null) {
      const exited = new Promise((resolve) => compositor.once('exit', resolve))
      process.kill(-compositor.pid, 'SIGTERM')
      await Promise.race([exited, sleep(5_000)])
      if (compositor.exitCode === null) process.kill(-compositor.pid, 'SIGKILL')
    }
    for (const path of ours) rmSync(path, { force: true })
    rmSync(userData, { recursive: true, force: true })
    rmSync(configHome, { recursive: true, force: true })
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err)
    process.exit(2)
  },
)
