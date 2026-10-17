// SPDX-License-Identifier: GPL-2.0-or-later
// Runs the conformance cases of conformance-cases.json against a Hub over
// HTTP: the Node fake (conformance.test.ts) or a local pipette-hub
// (local-hub.test.ts). The case format is described in the file's
// "format" lines; the pipette-hub crate runs the same cases against its
// in-memory Hub.

import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

export type Step = Record<string, unknown>

export interface ConformanceCase {
  name: string
  localHub?: boolean
  steps: Step[]
}

export interface ConformanceFile {
  templates: Record<string, Step[]>
  cases: ConformanceCase[]
}

export const CONFORMANCE: ConformanceFile = JSON.parse(
  readFileSync(new URL('./conformance-cases.json', import.meta.url), 'utf8'),
) as ConformanceFile

/** The boundary the desktop app's multipart builder would use at the
 *  fakes' clock start. */
const BOUNDARY = '----PipetteBoundary1767225600000'

export interface RunOptions {
  /** `{run}` in the case's strings. */
  run: string
  /** Sends a control step; absent for a Hub without control endpoints. */
  control?: (step: Step) => Promise<unknown>
  /** Retries a request the Hub's own rate limit refused (a local Hub). */
  retryRateLimited?: boolean
}

/** Whether a case runs against a Hub without control endpoints. */
export function runsWithoutControl(testCase: ConformanceCase): boolean {
  return testCase.localHub !== false && testCase.steps.every((step) => !('control' in step))
}

function substitute(value: unknown, saved: Map<string, unknown>, run: string, context: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
      if (name === 'run') return run
      if (!saved.has(name)) throw new Error(`${context}: nothing saved as ${name}`)
      return String(saved.get(name))
    })
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, saved, run, context))
  if (value !== null && typeof value === 'object') {
    const range = (value as { $range?: { prefix: string; count: number } }).$range
    if (range) return Array.from({ length: range.count }, (_, i) => `${range.prefix}${i + 1}`)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, saved, run, context)]))
  }
  return value
}

interface Part {
  name: string
  value?: string
  filename?: string
  contentType?: string
  content?: string
  contentBase64?: string
  contentJson?: unknown
}

/** The body the desktop app's MultipartBuilder writes for these parts. */
function multipartBody(parts: Array<Part | string>, templates: Record<string, Step[]>): Buffer {
  const chunks: Buffer[] = []
  const expanded = parts.flatMap((part) => (typeof part === 'string' ? (templates[part.slice(1)] as unknown as Part[]) : [part]))
  for (const part of expanded) {
    if (part.filename === undefined) {
      chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ''}\r\n`))
      continue
    }
    const content =
      part.contentBase64 !== undefined ? Buffer.from(part.contentBase64, 'base64')
      : part.contentJson !== undefined ? Buffer.from(JSON.stringify(part.contentJson))
      : Buffer.from(part.content ?? '')
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`))
    chunks.push(content, Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node === null || typeof node !== 'object' ? undefined : (node as Record<string, unknown>)[key]), value)
}

const STRING_PATTERNS: Record<string, RegExp> = {
  $uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  $jwt: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  $privateToken: /^pt_v1_[A-Za-z0-9_-]{43}$/,
  $hubStamp: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  $postCreatedStamp: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  $isoTimestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
}

/** Checks `actual` against the pattern; throws with the path that differs. */
export function matchPattern(actual: unknown, pattern: unknown, saved: Map<string, unknown>, path: string): void {
  const fail = (what: string): never => {
    throw new Error(`${path}: expected ${what}, got ${JSON.stringify(actual)}`)
  }
  if (typeof pattern === 'string' && pattern.startsWith('$')) {
    if (pattern === '$any') return
    if (pattern === '$string') return void (typeof actual === 'string' || fail('a string'))
    if (pattern === '$number') return void (typeof actual === 'number' || fail('a number'))
    if (pattern.startsWith('$saved:')) return void (actual === saved.get(pattern.slice(7)) || fail(JSON.stringify(saved.get(pattern.slice(7)))))
    if (pattern.startsWith('$after:')) {
      const before = saved.get(pattern.slice(7))
      return void ((typeof actual === 'string' && typeof before === 'string' && actual > before) || fail(`a string after ${JSON.stringify(before)}`))
    }
    const regex = STRING_PATTERNS[pattern]
    if (!regex) throw new Error(`${path}: unknown pattern ${pattern}`)
    return void ((typeof actual === 'string' && regex.test(actual)) || fail(pattern))
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual) || actual.length !== pattern.length) fail(`an array of ${pattern.length}`)
    pattern.forEach((item, i) => matchPattern((actual as unknown[])[i], item, saved, `${path}[${i}]`))
    return
  }
  if (pattern !== null && typeof pattern === 'object') {
    const object = pattern as Record<string, unknown>
    if ('$length' in object) return void ((Array.isArray(actual) && actual.length === object.$length) || fail(`an array of ${String(object.$length)}`))
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) fail('an object')
    const record = actual as Record<string, unknown>
    if (object.$keys !== undefined && JSON.stringify(Object.keys(record)) !== JSON.stringify(object.$keys)) fail(`the keys ${JSON.stringify(object.$keys)}`)
    for (const [key, item] of Object.entries(object)) {
      if (key === '$keys') continue
      if (item === '$absent') {
        if (key in record) fail(`no ${key}`)
        continue
      }
      if (!(key in record)) fail(`a key ${key}`)
      matchPattern(record[key], item, saved, `${path}.${key}`)
    }
    return
  }
  if (actual !== pattern) fail(JSON.stringify(pattern))
}

/** Sends a request step; resolves with its status, headers and body text. */
async function send(base: string, step: Step, saved: Map<string, unknown>, templates: Record<string, Step[]>): Promise<Response> {
  const [method, target] = String(step.request).split(' ', 2)
  const headers: Record<string, string> = {}
  if (typeof step.auth === 'string') {
    headers.Authorization = `Bearer ${step.auth.startsWith('!') ? step.auth.slice(1) : String(saved.get(step.auth))}`
  }
  let body: string | Buffer | undefined
  if ('json' in step) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(step.json)
  } else if ('raw' in step) {
    headers['Content-Type'] = 'application/json'
    body = String(step.raw)
  } else if ('multipart' in step) {
    headers['Content-Type'] = `multipart/form-data; boundary=${BOUNDARY}`
    body = multipartBody(step.multipart as Array<Part | string>, templates)
  }
  return fetch(`${base}${target}`, { method, headers, body })
}

export async function runCase(base: string, testCase: ConformanceCase, options: RunOptions, file: ConformanceFile = CONFORMANCE): Promise<void> {
  const saved = new Map<string, unknown>()
  for (const [index, rawStep] of testCase.steps.entries()) {
    const context = `${testCase.name} step ${index}`
    const step = substitute(rawStep, saved, options.run, context) as Step
    const templates = substitute(file.templates, saved, options.run, context) as Record<string, Step[]>
    if ('control' in step) {
      if (!options.control) throw new Error(`${context}: a control step needs a fake Hub`)
      const result = await options.control(step)
      if (typeof step.save === 'string') saved.set(step.save, (result as { id: string }).id)
      continue
    }
    const expectation = (step.expect ?? {}) as { status: number; headers?: Record<string, string | null>; json?: unknown; pretty?: boolean }
    let response = await send(base, step, saved, templates)
    while (options.retryRateLimited && response.status === 429 && expectation.status !== 429) {
      const wait = Number(response.headers.get('Retry-After') ?? '1')
      if (!(wait <= 60)) break
      await new Promise((resolve) => setTimeout(resolve, wait * 1000))
      response = await send(base, step, saved, templates)
    }
    const text = await response.text()
    expect(response.status, `${context}: ${text}`).toBe(expectation.status)
    for (const [name, value] of Object.entries(expectation.headers ?? {})) {
      expect(response.headers.get(name), `${context}: header ${name}`).toBe(value)
    }
    const parsed: unknown = text === '' ? null : JSON.parse(text)
    if (expectation.json !== undefined) matchPattern(parsed, expectation.json, saved, context)
    if (expectation.pretty) expect(text, `${context}: pretty-printed`).toBe(JSON.stringify(parsed, null, 2))
    for (const [name, path] of Object.entries((step.save ?? {}) as Record<string, string>)) {
      const value = at(parsed, path)
      if (value === undefined) throw new Error(`${context}: nothing at ${path} to save as ${name}`)
      saved.set(name, value)
    }
  }
}
