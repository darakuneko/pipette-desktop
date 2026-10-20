// SPDX-License-Identifier: GPL-2.0-or-later
// The Node fake Drive against the conformance cases it shares with the
// in-memory Drive of src-tauri/crates/pipette-drive (conformance-cases.json),
// each operation sent as src-tauri/crates/pipette-drive sends it; then the
// OAuth endpoints and the checks the Drive routes make.
//
// Run: pnpm run test:fake-drive

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeDriveEnv, startFakeDrive, type FakeDrive } from './server'

interface Step {
  op: string
  name?: string
  content?: string
  id?: string
  save?: string
  pageSize?: number
  nameContains?: string
  status?: number
  retryAfter?: string
  count?: number
  only?: string
  expect?: {
    status?: number
    retryAfter?: string | null
    reason?: string
    content?: string
    newer?: boolean
    name?: string
    sameIdAs?: string
    pageSizes?: number[]
    names?: string[]
  }
}

const CASES = JSON.parse(readFileSync(new URL('./conformance-cases.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; steps: Step[] }>
}

const AUTH = { Authorization: 'Bearer fake-access-token' }
const BOUNDARY = '---pipette-sync-boundary'

let drive: FakeDrive
let api: string
let upload: string

beforeEach(async () => {
  drive = await startFakeDrive()
  const env = fakeDriveEnv(drive.url)
  api = env.PIPETTE_DRIVE_API_URL
  upload = env.PIPETTE_DRIVE_UPLOAD_URL
})

afterEach(async () => {
  await drive.close()
})

/** The multipart body of a file create (pipette-drive's src/http.rs). */
function multipart(name: string, content: string): string {
  return [
    `--${BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify({ name, parents: ['appDataFolder'] }),
    `--${BOUNDARY}`,
    'Content-Type: application/json',
    '',
    content,
    `--${BOUNDARY}--`,
  ].join('\r\n')
}

function create(name: string, content: string, fields: string): Promise<Response> {
  return fetch(`${upload}/files?uploadType=multipart&fields=${fields}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': `multipart/related; boundary=${BOUNDARY}` },
    body: multipart(name, content),
  })
}

function listPage(nameContains: string | undefined, pageSize: number, pageToken: string | undefined): Promise<Response> {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'nextPageToken, files(id, name, modifiedTime, createdTime)',
    pageSize: String(pageSize),
  })
  if (nameContains) params.set('q', `name contains '${nameContains.replace(/'/g, "\\'")}'`)
  if (pageToken) params.set('pageToken', pageToken)
  return fetch(`${api}/files?${params}`, { headers: AUTH })
}

interface Saved {
  id: string
  modifiedTime: string
}

/** Sends one step; resolves with the failed response, or null on success. */
async function runStep(step: Step, saved: Map<string, Saved>, context: string): Promise<Response | null> {
  const expectation = step.expect ?? {}
  // A key no earlier step saved is a mistake in the case, as in the Rust
  // runner (tests/conformance.rs), not an empty id or time to compare with.
  const savedFile = (key: string | undefined): Saved => {
    const file = key === undefined ? undefined : saved.get(key)
    if (!file) throw new Error(`${context}: no file saved as ${key}`)
    return file
  }
  const idOf = (): string => (step.id === 'missing' ? 'missing-id' : savedFile(step.id).id)
  const save = (file: Saved): void => {
    if (!step.save) return
    if (expectation.newer) expect(file.modifiedTime > savedFile(step.save).modifiedTime, context).toBe(true)
    saved.set(step.save, file)
  }
  const ok = async (response: Response): Promise<unknown> => {
    if (!response.ok) throw response
    const text = await response.text()
    return text === '' ? null : JSON.parse(text)
  }
  try {
    switch (step.op) {
      case 'fault': {
        const fault = { status: step.status, retryAfter: step.retryAfter ?? null, count: step.count, only: step.only }
        await fetch(`${drive.url}/__control/faults`, { method: 'POST', body: JSON.stringify(fault) })
        return null
      }
      case 'create':
        save((await ok(await create(step.name ?? '', step.content ?? '', 'id,modifiedTime'))) as Saved)
        return null
      case 'createRaw': {
        const answer = (await ok(await create(step.name ?? '', step.content ?? '', 'id'))) as { id: string }
        expect(Object.keys(answer), context).toEqual(['id'])
        save({ id: answer.id, modifiedTime: '' })
        return null
      }
      case 'update': {
        const response = await fetch(`${upload}/files/${idOf()}?uploadType=media&fields=id,modifiedTime`, {
          method: 'PATCH',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: step.content,
        })
        save((await ok(response)) as Saved)
        return null
      }
      case 'rename': {
        const response = await fetch(`${api}/files/${idOf()}?fields=id,name,modifiedTime`, {
          method: 'PATCH',
          headers: { ...AUTH, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: step.name }),
        })
        const file = (await ok(response)) as Saved & { name: string }
        expect(file.name, context).toBe(expectation.name)
        if (expectation.sameIdAs) expect(file.id, context).toBe(savedFile(expectation.sameIdAs).id)
        save(file)
        return null
      }
      case 'delete':
        await ok(await fetch(`${api}/files/${idOf()}`, { method: 'DELETE', headers: AUTH }))
        return null
      case 'download': {
        const response = await fetch(`${api}/files/${idOf()}?alt=media`, { headers: AUTH })
        if (!response.ok) throw response
        expect(await response.text(), context).toBe(expectation.content)
        return null
      }
      case 'listPages': {
        const sizes: number[] = []
        const names: string[] = []
        let pageToken: string | undefined
        do {
          const page = (await ok(await listPage(step.nameContains, step.pageSize ?? 1000, pageToken))) as {
            files: Array<{ id: string; name: string; modifiedTime: string; createdTime: string }>
            nextPageToken?: string
          }
          sizes.push(page.files.length)
          for (const file of page.files) {
            expect(file.id && file.modifiedTime && file.createdTime, context).toBeTruthy()
            names.push(file.name)
          }
          pageToken = page.nextPageToken
        } while (pageToken)
        expect(sizes, context).toEqual(expectation.pageSizes)
        expect(names.sort(), context).toEqual([...(expectation.names ?? [])].sort())
        return null
      }
      default:
        throw new Error(`${context}: unknown step ${step.op}`)
    }
  } catch (err) {
    if (err instanceof Response) return err
    throw err
  }
}

describe('the fake Drive', () => {
  it('passes the conformance cases', async () => {
    expect(CASES.cases).toHaveLength(5)
    for (const { name, steps } of CASES.cases) {
      await fetch(`${drive.url}/__control/reset`, { method: 'POST' })
      const saved = new Map<string, Saved>()
      for (const [index, step] of steps.entries()) {
        const context = `${name} step ${index}`
        const failed = await runStep(step, saved, context)
        const expectation = step.expect ?? {}
        if (expectation.status === undefined) {
          expect(failed?.status, context).toBeUndefined()
          continue
        }
        expect(failed?.status, context).toBe(expectation.status)
        if ('retryAfter' in expectation) expect(failed?.headers.get('Retry-After') ?? null, context).toBe(expectation.retryAfter)
        if (expectation.reason) expect(await failed?.text(), context).toContain(`"reason":"${expectation.reason}"`)
      }
    }
  })

  it('listens on 127.0.0.1 only', () => {
    expect(new URL(drive.url).hostname).toBe('127.0.0.1')
  })

  it('answers 401 without a bearer token', async () => {
    const response = await fetch(`${api}/files?spaces=appDataFolder`)
    expect(response.status).toBe(401)
  })

  it('refuses a create outside appDataFolder and a listing of other spaces', async () => {
    const body = multipart('a.enc', '{}').replace('"parents":["appDataFolder"]', '"parents":["root"]')
    const response = await fetch(`${upload}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': `multipart/related; boundary=${BOUNDARY}` },
      body,
    })
    expect(response.status).toBe(400)
    expect((await fetch(`${api}/files?spaces=drive`, { headers: AUTH })).status).toBe(400)
  })

  it('keeps the content bytes of a multipart create', async () => {
    const content = JSON.stringify({ text: 'é\u{1F600}\r\n--x' })
    const { id } = (await (await create('a.enc', content, 'id')).json()) as { id: string }
    expect(await (await fetch(`${api}/files/${id}?alt=media`, { headers: AUTH })).text()).toBe(content)
    expect(drive.state.files[0].mimeType).toBe('application/json')
  })

  it('answers only the fields a listing asks for, as Drive does', async () => {
    await create('a.enc', '{}', 'id')
    await create('b.enc', '{}', 'id')
    const list = async (fields: string | null): Promise<Response> => {
      const params = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1' })
      if (fields !== null) params.set('fields', fields)
      return fetch(`${api}/files?${params}`, { headers: AUTH })
    }
    // A request that leaves out nextPageToken or modifiedTime gets neither.
    expect(await (await list('files(id, name)')).json()).toEqual({ files: [{ id: 'fake-1', name: 'a.enc' }] })
    expect(await (await list('nextPageToken')).json()).toEqual({ nextPageToken: 'page-1' })
    expect(await (await list(null)).json()).toEqual({
      kind: 'drive#fileList',
      incompleteSearch: false,
      nextPageToken: 'page-1',
      files: [{ kind: 'drive#file', id: 'fake-1', name: 'a.enc', mimeType: 'application/json' }],
    })
    for (const fields of ['files(id', 'files(id(x))', 'nextPageToken, items', 'files(id name)']) {
      expect((await list(fields)).status, fields).toBe(400)
    }
  })

  it('stops a case at a key no earlier step saved', async () => {
    await expect(runStep({ op: 'download', id: 'unsaved', expect: { content: '' } }, new Map(), 'case')).rejects.toThrow(/no file saved as unsaved/)
    const saved = new Map<string, Saved>()
    await runStep({ op: 'create', name: 'a.enc', content: 'x', save: 'a' }, saved, 'case')
    const update = { op: 'update', id: 'a', content: 'y', save: 'unsaved', expect: { newer: true } }
    await expect(runStep(update, saved, 'case')).rejects.toThrow(/no file saved as unsaved/)
  })

  it('records the requests', async () => {
    await listPage('a', 10, undefined)
    expect(drive.requests).toEqual([
      {
        method: 'GET',
        path: '/drive/v3/files',
        query: { spaces: 'appDataFolder', fields: 'nextPageToken, files(id, name, modifiedTime, createdTime)', pageSize: '10', q: "name contains 'a'" },
      },
    ])
  })
})

describe('the fake OAuth endpoints', () => {
  const env = (): Record<string, string> => fakeDriveEnv(drive.url)

  async function authorize(verifier: string): Promise<URL> {
    const params = new URLSearchParams({
      client_id: 'client',
      redirect_uri: 'http://127.0.0.1:4567',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'state-1',
    })
    const response = await fetch(`${env().PIPETTE_GOOGLE_AUTH_URL}?${params}`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    return new URL(response.headers.get('Location') ?? '')
  }

  function token(form: Record<string, string>): Promise<Response> {
    return fetch(env().PIPETTE_GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
  }

  it('signs in with PKCE and refreshes the access token', async () => {
    const verifier = randomBytes(32).toString('base64url')
    const redirect = await authorize(verifier)
    expect(redirect.origin).toBe('http://127.0.0.1:4567')
    expect(redirect.searchParams.get('state')).toBe('state-1')
    const code = redirect.searchParams.get('code') ?? ''

    expect((await token({ grant_type: 'authorization_code', code, code_verifier: 'wrong' })).status).toBe(400)
    const exchanged = (await (await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'client' })).json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      id_token: string
    }
    expect(exchanged.expires_in).toBe(3600)
    const payload = JSON.parse(Buffer.from(exchanged.id_token.split('.')[1], 'base64url').toString('utf8')) as { sub: string; email: string }
    expect(payload).toMatchObject({ sub: 'fake-sub-1', email: 'fake-user@example.invalid' })
    // A code is good once.
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier })).status).toBe(400)

    await fetch(`${drive.url}/__control/account`, { method: 'POST', body: JSON.stringify({ sub: 'fake-sub-2', email: 'b@example.invalid' }) })
    const refreshed = (await (await token({ grant_type: 'refresh_token', refresh_token: exchanged.refresh_token })).json()) as {
      access_token: string
      id_token: string
      refresh_token?: string
    }
    expect(refreshed.access_token).not.toBe(exchanged.access_token)
    expect(refreshed.refresh_token).toBeUndefined()
    // The token stays with the account it was issued for; a new sign-in
    // gets the switched one.
    expect(JSON.parse(Buffer.from(refreshed.id_token.split('.')[1], 'base64url').toString('utf8'))).toMatchObject({ sub: 'fake-sub-1' })
    const verifierB = randomBytes(32).toString('base64url')
    const codeB = (await authorize(verifierB)).searchParams.get('code') ?? ''
    const signedInB = (await (await token({ grant_type: 'authorization_code', code: codeB, code_verifier: verifierB })).json()) as { id_token: string }
    expect(JSON.parse(Buffer.from(signedInB.id_token.split('.')[1], 'base64url').toString('utf8'))).toMatchObject({ sub: 'fake-sub-2' })
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'unknown' })).status).toBe(400)
  })

  it('redirects only to a loopback port', async () => {
    const params = new URLSearchParams({ redirect_uri: 'https://example.invalid/', code_challenge: 'x', code_challenge_method: 'S256' })
    expect((await fetch(`${env().PIPETTE_GOOGLE_AUTH_URL}?${params}`, { redirect: 'manual' })).status).toBe(400)
  })

  it('fails a token request on an injected fault', async () => {
    await fetch(`${drive.url}/__control/faults`, { method: 'POST', body: JSON.stringify({ status: 503, count: 1, only: 'token' }) })
    expect((await token({ grant_type: 'refresh_token', refresh_token: 'x' })).status).toBe(503)
  })
})
