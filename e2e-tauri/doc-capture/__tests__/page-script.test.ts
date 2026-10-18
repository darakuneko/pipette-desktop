// SPDX-License-Identifier: GPL-2.0-or-later
// The scripts that send a function to the page as its source text still run
// when the loader of the e2e files (esbuild with keepNames) has wrapped the
// function's inner functions in `__name(...)`, which the page does not have.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { callScript, callWithElementScript, type queryPage } from '../page-query'

const globals = globalThis as unknown as { document?: unknown }

afterEach(() => {
  delete globals.document
})

/** `queryPage` as the e2e loader compiles it. */
async function compiledQueryPage(): Promise<typeof queryPage> {
  const path = fileURLToPath(new URL('../page-query.ts', import.meta.url))
  const compiled = await transformWithEsbuild(readFileSync(path, 'utf8'), path, {
    format: 'iife',
    globalName: 'pageQuery',
    keepNames: true,
  })
  return (new Function(`${compiled.code}; return pageQuery;`)() as { queryPage: typeof queryPage }).queryPage
}

describe('callScript', () => {
  it('runs a function whose inner functions the loader wrapped in __name', async () => {
    const source = (await compiledQueryPage()).toString()
    expect(source).toContain('__name(')
    // An empty chain finds nothing without touching the page.
    globals.document = {}
    expect(() => new Function(`return (${source}).apply(null, arguments);`)([], 'count', null)).toThrow(/__name/)
    expect(new Function(callScript(source))([], 'count', null)).toBe(0)
  })
})

describe('callWithElementScript', () => {
  it('calls the function with the element its first argument selects', () => {
    const element = { id: 'found' }
    globals.document = { querySelector: (selector: string) => (selector === '#a' ? element : null) }
    const script = callWithElementScript(((el: { id: string }) => el.id).toString())
    expect(new Function(script)('#a')).toBe('found')
  })
})
