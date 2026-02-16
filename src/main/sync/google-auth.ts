// SPDX-License-Identifier: GPL-2.0-or-later
// Google OAuth2 for Drive API (desktop app flow with PKCE + loopback redirect)

import { shell, safeStorage, app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SyncAuthStatus } from '../../shared/types/sync'

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

async function storeTokens(tokens: StoredTokens): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is not available')
  }

  const json = JSON.stringify(tokens)
  const encrypted = safeStorage.encryptString(json)
  const dir = join(app.getPath('userData'), 'local', 'auth')
  await mkdir(dir, { recursive: true })
  await writeFile(getTokenPath(), encrypted)
  cachedTokens = tokens
}

async function loadTokens(): Promise<StoredTokens | null> {
  if (cachedTokens) return cachedTokens

  try {
    const encrypted = await readFile(getTokenPath())
    const json = safeStorage.decryptString(encrypted as Buffer)
    const tokens = JSON.parse(json) as StoredTokens
    cachedTokens = tokens
    return tokens
  } catch {
    return null
  }
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  port: number,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `http://127.0.0.1:${port}`,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: codeVerifier,
  })

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
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

  await storeTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    idToken: data.id_token ?? null,
  })
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
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
  await storeTokens({
    accessToken: data.access_token,
    refreshToken, // Refresh token doesn't change on refresh
    expiresAt: Date.now() + data.expires_in * 1000,
    idToken: data.id_token ?? existing?.idToken ?? null,
  })

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
  const tokens = await loadTokens()
  return { authenticated: tokens !== null }
}

export async function signOut(): Promise<void> {
  cachedTokens = null
  try {
    await unlink(getTokenPath())
  } catch {
    // Already deleted — ignore
  }
}

export async function startOAuthFlow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>Authorization failed</h1><p>You can close this window.</p></body></html>')
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (!code || returnedState !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>Invalid request</h1></body></html>')
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>')

      const port = (server.address() as { port: number }).port
      exchangeCodeForTokens(code, codeVerifier, port)
        .then(() => {
          server.close()
          resolve()
        })
        .catch((err) => {
          server.close()
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
        server.close()
        reject(err)
      })
    })

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close()
      reject(new Error('OAuth flow timed out'))
    }, 5 * 60 * 1000)
  })
}
