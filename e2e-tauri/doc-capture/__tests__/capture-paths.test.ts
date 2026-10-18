// SPDX-License-Identifier: GPL-2.0-or-later
// Where the capture may write: a userData directory inside the temporary
// directory and outside every real configuration directory, and the
// screenshots into docs/screenshots or a directory inside the temporary
// directory, symbolic links resolved.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertCaptureUserData, DOCS_SCREENSHOT_DIR, SCREENSHOT_DIR_VARIABLE, screenshotDir } from '../capture-paths'

let root: string
/** The temporary directory the checks are given. */
let temp: string
/** A home directory outside it, whose .config is a real configuration
 *  directory. */
let home: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pipette-capture-paths-')))
  temp = join(root, 'tmp')
  home = join(root, 'home')
  mkdirSync(temp)
  mkdirSync(join(home, '.config', 'pipette-desktop'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('assertCaptureUserData', () => {
  it('takes a directory inside the temporary directory', () => {
    const dir = join(temp, 'pipette-e2e-tauri-1')
    mkdirSync(dir)
    expect(assertCaptureUserData(dir, { HOME: home }, temp)).toBe(dir)
  })

  it('refuses the real userData, through a link too', () => {
    const real = join(home, '.config', 'pipette-desktop')
    expect(() => assertCaptureUserData(real, { HOME: home }, temp)).toThrow(/real configuration directory/)
    const link = join(temp, 'link')
    symlinkSync(real, link)
    expect(() => assertCaptureUserData(link, { HOME: home }, temp)).toThrow(/real configuration directory/)
  })

  it('refuses a directory under XDG_CONFIG_HOME', () => {
    const config = join(temp, 'config')
    mkdirSync(join(config, 'app'), { recursive: true })
    expect(() => assertCaptureUserData(join(config, 'app'), { HOME: home, XDG_CONFIG_HOME: config }, temp)).toThrow(
      /real configuration directory/,
    )
  })

  it('refuses the temporary directory itself and anything outside it', () => {
    expect(() => assertCaptureUserData(temp, { HOME: home }, temp)).toThrow(/not inside the temporary directory/)
    const outside = join(root, 'elsewhere')
    mkdirSync(outside)
    expect(() => assertCaptureUserData(outside, { HOME: home }, temp)).toThrow(/not inside the temporary directory/)
  })
})

describe('screenshotDir', () => {
  it('is docs/screenshots by default and when named', () => {
    const docs = realpathSync(DOCS_SCREENSHOT_DIR)
    expect(screenshotDir({}, temp)).toBe(docs)
    expect(screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: '' }, temp)).toBe(docs)
    expect(screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: DOCS_SCREENSHOT_DIR }, temp)).toBe(docs)
  })

  it('takes a directory inside the temporary directory, made or not', () => {
    const out = join(temp, 'shots', 'run-1')
    expect(screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: out }, temp)).toBe(out)
  })

  it('refuses a relative path, the temporary directory itself, a place outside it and a link out of it', () => {
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: 'shots' }, temp)).toThrow(/absolute path/)
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: temp }, temp)).toThrow(/must be docs\/screenshots or inside/)
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: join(home, '.config') }, temp)).toThrow(/must be docs\/screenshots or inside/)
    const link = join(temp, 'out')
    symlinkSync(join(home, '.config'), link)
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: join(link, 'shots') }, temp)).toThrow(/must be docs\/screenshots or inside/)
  })
})
