// SPDX-License-Identifier: GPL-2.0-or-later
// Google OAuth2 for Drive API (desktop app flow with PKCE + loopback redirect)

import { shell, safeStorage, app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncAuthStatus } from '../../shared/types/sync'
import { getHubTestAccount } from '../hub/hub-base'

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email profile'
const TOKEN_FILE = 'oauth-tokens.enc'

const CLIENT_ID = '456971912849-ktrhpfv849jli5qph50i2rlflv1aadqq.apps.googleusercontent.com'
const CLIENT_SECRET = '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'

function getTokenPath(): string {
  return join(app.getPath('userData'), 'local', 'auth', TOKEN_FILE)
}

interface StoredTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp ms
  idToken: string | null
}

// In-memory token cache
let cachedTokens: StoredTokens | null = null

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function generateState(): string {
  return randomBytes(16).toString('hex')
}

export function generateAuthUrl(port: number): {
  url: string
  codeVerifier: string
  state: string
} {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: `http://127.0.0.1:${port}`,
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  })

  return {
    url: `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`,
    codeVerifier,
    state,
  }
}

/** Bumped by every sign-in and sign-out. A refresh or a read that started
 *  under an older session stores nothing, so it cannot bring back an
 *  account that was signed out of or replaced meanwhile. */
let sessionGeneration = 0

/** Token file reads, writes and removals, run one at a time in call
 *  order. */
let tokenFileQueue: Promise<unknown> = Promise.resolve()

function queueTokenFileWork<T>(work: () => Promise<T>): Promise<T> {
  const run = tokenFileQueue.then(work)
  tokenFileQueue = run.catch(() => {})
  return run
}

/** Stores `tokens` unless the session changed since `generation` was
 *  taken (then throws). */
function storeTokens(tokens: StoredTokens, generation: number): Promise<void> {
  return queueTokenFileWork(async () => {
    if (generation !== sessionGeneration) throw new Error('The sign-in changed; the tokens were not stored')
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS keychain encryption is not available')
    }

    const json = JSON.stringify(tokens)
    const encrypted = safeStorage.encryptString(json)
    const dir = join(app.getPath('userData'), 'local', 'auth')
    await mkdir(dir, { recursive: true })
    await writeFile(getTokenPath(), encrypted)
    // A sign-out during the write removes the file next (it is queued after
    // this), so these tokens must not stay cached either.
    if (generation !== sessionGeneration) throw new Error('The sign-in changed; the tokens were not stored')
    cachedTokens = tokens
  })
}

async function loadTokens(): Promise<StoredTokens | null> {
  if (cachedTokens) return cachedTokens

  const generation = sessionGeneration
  // Queued after any pending write or removal, so a read never sees a file
  // a sign-out is about to remove.
  return queueTokenFileWork(async () => {
    try {
      const encrypted = await readFile(getTokenPath())
      const json = safeStorage.decryptString(encrypted as Buffer)
      const tokens = JSON.parse(json) as StoredTokens
      // A sign-in or sign-out during the read decides what is signed in.
      if (generation !== sessionGeneration) return cachedTokens
      cachedTokens = tokens
      return tokens
    } catch {
      return null
    }
  })
}

/** Runs `storeTokens`, which replaces the signed-in account's tokens with
 *  those of `newAccountSub`'s account (null when its id_token has no
 *  `sub`). A caller passes one to run its own steps around the switch
 *  (e.g. hold the sync lock so no sync request uses the new tokens for
 *  work started under the old ones), or to refuse it by throwing without
 *  calling `storeTokens`. */
export type TokenSwitch = (storeTokens: () => Promise<void>, newAccountSub: string | null) => Promise<void>

const switchDirectly: TokenSwitch = (store) => store()

/** How long the token exchange of a sign-in may take. Exported so tests can
 *  shorten it. */
export const tokenExchangeTiming = {
  timeoutMs: 60_000,
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  port: number,
  switchTokens: TokenSwitch = switchDirectly,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `http://127.0.0.1:${port}`,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: codeVerifier,
  })

  // Bounds the request and its body, so the sign-in always settles once
  // the code has arrived.
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(tokenExchangeTiming.timeoutMs),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Token exchange failed: ${response.status} ${text}`)
  }

  const data = (await response.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    token_type: string
    id_token?: string
  }

  const tokens: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    idToken: data.id_token ?? null,
  }
  await switchTokens(() => storeTokens(tokens, ++sessionGeneration), accountSubOf(tokens.idToken))
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const generation = sessionGeneration
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Token refresh failed: ${response.status} ${text}`)
  }

  const data = (await response.json()) as {
    access_token: string
    expires_in: number
    token_type: string
    id_token?: string
  }

  const existing = await loadTokens()
  // Throws when a sign-in or sign-out happened during the refresh.
  await storeTokens({
    accessToken: data.access_token,
    refreshToken, // Refresh token doesn't change on refresh
    expiresAt: Date.now() + data.expires_in * 1000,
    idToken: data.id_token ?? existing?.idToken ?? null,
  }, generation)

  return data.access_token
}

export async function getAccessToken(): Promise<string | null> {
  const tokens = await loadTokens()
  if (!tokens) return null

  // Refresh 5 minutes before expiry
  if (Date.now() >= tokens.expiresAt - 5 * 60 * 1000) {
    try {
      return await refreshAccessToken(tokens.refreshToken)
    } catch {
      return null
    }
  }

  return tokens.accessToken
}

function parseJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const payloadB64 = jwt.split('.')[1]
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as Record<string, unknown>
  } catch {
    return null
  }
}

/** The `sub` claim of `idToken`; null when it has none. */
function accountSubOf(idToken: string | null | undefined): string | null {
  if (!idToken) return null
  const sub = parseJwtPayload(idToken)?.sub
  return typeof sub === 'string' && sub !== '' ? sub : null
}

/** The opaque id (id_token `sub`, the same for one Google account) of the
 *  account Drive sync is signed in to; null when signed out or when the
 *  tokens carry no id_token. A refresh keeps the stored id_token when it
 *  returns none. Reads the stored tokens only: the Hub test account is not
 *  a Drive sign-in. */
export async function getAccountSub(): Promise<string | null> {
  return accountSubOf((await loadTokens())?.idToken)
}

function isJwtExpired(jwt: string): boolean {
  const payload = parseJwtPayload(jwt)
  if (!payload || typeof payload.exp !== 'number') return true
  return Date.now() >= payload.exp * 1000
}

/** Check if jwt iat is older than maxAge seconds (Hub rejects stale tokens) */
function isJwtStale(jwt: string, maxAgeSeconds: number): boolean {
  const payload = parseJwtPayload(jwt)
  if (!payload || typeof payload.iat !== 'number') return true
  return Date.now() / 1000 - payload.iat > maxAgeSeconds
}

const ID_TOKEN_MAX_AGE = 300 // refresh if older than 5 min (Hub allows 10 min)

export async function getIdToken(): Promise<string | null> {
  // Local Hub test mode: a Hub running with TEST_MODE (pnpm run dev:test)
  // accepts the `test:<email>` sentinel in place of a Google id_token.
  // Only Hub auth is faked — Google Drive sync deliberately keeps its
  // real behavior (no access tokens exist, so sync stays disabled).
  const testAccount = getHubTestAccount()
  if (testAccount) return `test:${testAccount}`

  const tokens = await loadTokens()
  if (!tokens) return null

  // If id_token is missing, expired, or too old for Hub, refresh it
  if (!tokens.idToken || isJwtExpired(tokens.idToken) || isJwtStale(tokens.idToken, ID_TOKEN_MAX_AGE)) {
    if (!tokens.refreshToken) return null
    try {
      await refreshAccessToken(tokens.refreshToken)
      const refreshed = await loadTokens()
      if (refreshed?.idToken && !isJwtExpired(refreshed.idToken) && !isJwtStale(refreshed.idToken, ID_TOKEN_MAX_AGE)) {
        return refreshed.idToken
      }
    } catch {
      // Refresh failed
    }
    return null
  }

  return tokens.idToken
}

export async function getAuthStatus(): Promise<SyncAuthStatus> {
  // Local Hub test mode reports authenticated so hub-gated UI opens.
  // Drive access tokens stay null, so sync itself remains disabled.
  if (getHubTestAccount()) return { authenticated: true }
  const tokens = await loadTokens()
  return { authenticated: tokens !== null }
}

export async function signOut(): Promise<void> {
  sessionGeneration++
  cachedTokens = null
  await queueTokenFileWork(async () => {
    try {
      await unlink(getTokenPath())
    } catch {
      // Already deleted — ignore
    }
  })
}

/** Signs in through the browser. The new tokens are stored through
 *  `switchTokens` once Google has issued them. */
export async function startOAuthFlow(switchTokens: TokenSwitch = switchDirectly): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let finished = false
    let codeReceived = false

    function teardown(): void {
      if (finished) return
      finished = true
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      server.close()
    }

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>Authorization failed</h1><p>You can close this window.</p></body></html>')
        teardown()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (!code || returnedState !== expectedState || codeReceived) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>Invalid request</h1></body></html>')
        return
      }
      // The timeout covers the browser step only; the exchange and the
      // token switch (bounded by the caller) run past it.
      codeReceived = true
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>')

      const port = (server.address() as { port: number }).port
      exchangeCodeForTokens(code, codeVerifier, port, switchTokens)
        .then(() => {
          teardown()
          resolve()
        })
        .catch((err) => {
          teardown()
          reject(err)
        })
    })

    let expectedState = ''
    let codeVerifier = ''

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      const auth = generateAuthUrl(port)
      expectedState = auth.state
      codeVerifier = auth.codeVerifier

      shell.openExternal(auth.url).catch((err) => {
        teardown()
        reject(err)
      })
    })

    // Timeout after 5 minutes
    timeoutId = setTimeout(() => {
      if (finished) return
      timeoutId = null
      teardown()
      reject(new Error('OAuth flow timed out'))
    }, 5 * 60 * 1000)
  })
}
