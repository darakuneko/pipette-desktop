// SPDX-License-Identifier: GPL-2.0-or-later
// A fake update server for the in-app update tests: it serves an update
// manifest in the form the release's latest.json has (every platform), and
// the update file it names, signed with the test-only key
// (test-only-signer.ts). It keeps its state in memory and listens on
// 127.0.0.1 only.
//
//   GET /manifest.json        the manifest of the scripted release, a 204, or
//                             a body that is not JSON (`mode`)
//   GET /download/<file>      the update file
// Control endpoints (JSON bodies; every write answers `{}`):
//   POST /__control/release   {version, tamper?}  the release from now on
//   POST /__control/mode      {mode}              'release' | 'noContent' | 'notJson'
//   POST /__control/reset                         no release, mode 'release', empty log
//   GET  /__control/requests                      the log
// Without a release the manifest answers 204, as an up-to-date server may.
//
// A tampered release: 'signature' signs other bytes than the file served;
// 'version' binds an older version into the signature than the manifest
// announces (an old signed release offered as a new one).
//
// The development tools' build reaches it through the variables of
// `fakeUpdateEnv`. Run on its own:
//   npx tsx scripts/fake-update/server.ts [port]

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { listenOnLoopback, readBody, runStandalone } from '../fake-server/server-support'
import { TEST_ONLY_PUBKEY, testOnlySign } from './test-only-signer'

const MAX_BODY_BYTES = 64 * 1024

/** The update file every platform of the manifest points at. */
export const UPDATE_FILE = 'pipette-fake-update.bin'

/** The platforms of a release's latest.json (scripts/update-manifest). */
export const FAKE_PLATFORMS = [
  'linux-x86_64-appimage',
  'linux-x86_64',
  'windows-x86_64-nsis',
  'windows-x86_64',
  'darwin-aarch64-app',
  'darwin-aarch64',
] as const

export type Tamper = 'none' | 'signature' | 'version'
export type Mode = 'release' | 'noContent' | 'notJson'

export interface FakeRelease {
  version: string
  tamper?: Tamper
}

export interface LoggedUpdateRequest {
  method: string
  path: string
  receivedAt: number
}

export interface FakeUpdate {
  /** `http://127.0.0.1:<port>` */
  url: string
  /** The manifest's address. */
  manifestUrl: string
  /** Each request in turn, the control endpoints left out. */
  requests: LoggedUpdateRequest[]
  /** The release the manifest announces from now on. */
  setRelease: (release: FakeRelease | null) => void
  setMode: (mode: Mode) => void
  reset: () => void
  close: () => Promise<void>
}

/** The variables that point a development build at the fake server. */
export function fakeUpdateEnv(url: string): Record<string, string> {
  return { PIPETTE_UPDATER_MANIFEST_URL: `${url}/manifest.json`, PIPETTE_DEV_UPDATER_PUBKEY: TEST_ONLY_PUBKEY }
}

/** The bytes served as the update of `version`. */
export function payloadOf(version: string): Buffer {
  return Buffer.from(`pipette fake update ${version}\n`, 'utf8')
}

/** The signature of the update of `release`, tampered as it says. */
export function signatureOf(release: FakeRelease): string {
  const payload = payloadOf(release.version)
  switch (release.tamper ?? 'none') {
    case 'signature':
      return testOnlySign(Buffer.from('not the file that is served'), { version: release.version, file: UPDATE_FILE })
    case 'version':
      return testOnlySign(payload, { version: '0.0.1', file: UPDATE_FILE })
    case 'none':
      return testOnlySign(payload, { version: release.version, file: UPDATE_FILE })
  }
}

/** The manifest announcing `release`, its files under `url`. */
export function manifestOf(url: string, release: FakeRelease): Record<string, unknown> {
  const entry = { url: `${url}/download/${UPDATE_FILE}`, signature: signatureOf(release) }
  return {
    version: release.version,
    notes: `Fake release ${release.version}`,
    pub_date: '2026-10-20T00:00:00Z',
    platforms: Object.fromEntries(FAKE_PLATFORMS.map((name) => [name, entry])),
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

export async function startFakeUpdate(options: { port?: number } = {}): Promise<FakeUpdate> {
  let release: FakeRelease | null = null
  let mode: Mode = 'release'
  const requests: LoggedUpdateRequest[] = []
  let base = ''

  function reset(): void {
    release = null
    mode = 'release'
    requests.length = 0
  }

  async function control(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method === 'GET' && path === '/__control/requests') return send(res, 200, JSON.stringify(requests))
    if (req.method !== 'POST') return send(res, 405, '{}')
    const text = (await readBody(req, MAX_BODY_BYTES)).toString('utf8')
    const body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>
    switch (path) {
      case '/__control/release':
        release = body.version === null ? null : { version: String(body.version), tamper: (body.tamper as Tamper | undefined) ?? 'none' }
        break
      case '/__control/mode':
        mode = body.mode as Mode
        break
      case '/__control/reset':
        reset()
        break
      default:
        return send(res, 404, '{}')
    }
    send(res, 200, '{}')
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path.startsWith('/__control/')) {
      control(req, res, path).catch((err: unknown) => send(res, 400, JSON.stringify({ error: String(err) })))
      return
    }
    requests.push({ method: req.method ?? '', path, receivedAt: Date.now() })
    if (req.method !== 'GET') return send(res, 405, '{}')
    if (path === '/manifest.json') {
      if (mode === 'notJson') return send(res, 200, '<html>not json</html>', 'text/html')
      if (mode === 'noContent' || release === null) {
        res.writeHead(204)
        res.end()
        return
      }
      return send(res, 200, JSON.stringify(manifestOf(base, release)))
    }
    if (path === `/download/${UPDATE_FILE}` && release !== null) {
      return send(res, 200, payloadOf(release.version), 'application/octet-stream')
    }
    send(res, 404, '{}')
  })
  const { url, close } = await listenOnLoopback(server, options.port, 'fake update server')
  base = url
  return {
    url,
    manifestUrl: `${url}/manifest.json`,
    requests,
    setRelease: (next) => { release = next },
    setMode: (next) => { mode = next },
    reset,
    close,
  }
}

runStandalone(import.meta.url, startFakeUpdate, fakeUpdateEnv)
