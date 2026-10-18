// SPDX-License-Identifier: GPL-2.0-or-later
// Where the capture may write: a userData directory inside the temporary
// directory and outside every real configuration directory, and the
// screenshots into docs/screenshots or a directory inside the temporary
// directory, symbolic links resolved.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertCaptureUserData,
  DOCS_SCREENSHOT_DIR,
  SCREENSHOT_DIR_VARIABLE,
  screenshotDir,
  screenshotPath,
  type ScreenshotDirPlaces,
} from '../capture-paths'

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

/** The real project's docs/screenshots with the test's temporary
 *  directory. */
function places(): ScreenshotDirPlaces {
  return { projectRoot: dirname(dirname(DOCS_SCREENSHOT_DIR)), docsDir: DOCS_SCREENSHOT_DIR, tempDir: temp }
}

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
    expect(screenshotDir({}, places())).toBe(docs)
    expect(screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: '' }, places())).toBe(docs)
    expect(screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: DOCS_SCREENSHOT_DIR }, places())).toBe(docs)
  })

  it('takes a directory inside the temporary directory, made or not', () => {
    const out = join(temp, 'shots', 'run-1')
    expect(screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: out }, places())).toBe(out)
  })

  it('refuses a relative path, the temporary directory itself, a place outside it and a link out of it', () => {
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: 'shots' }, places())).toThrow(/absolute path/)
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: temp }, places())).toThrow(/must be docs\/screenshots or inside/)
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: join(home, '.config') }, places())).toThrow(/must be docs\/screenshots or inside/)
    const link = join(temp, 'out')
    symlinkSync(join(home, '.config'), link)
    expect(() => screenshotDir({ [SCREENSHOT_DIR_VARIABLE]: join(link, 'shots') }, places())).toThrow(/must be docs\/screenshots or inside/)
  })

  it('refuses a docs/screenshots that resolves out of the project, into a real configuration directory', () => {
    const project = join(root, 'project')
    mkdirSync(join(project, 'docs'), { recursive: true })
    const real = join(home, '.config', 'shots')
    mkdirSync(real)
    symlinkSync(real, join(project, 'docs', 'screenshots'))
    const linked = { projectRoot: project, docsDir: join(project, 'docs', 'screenshots'), tempDir: temp }
    expect(() => screenshotDir({ HOME: home }, linked)).toThrow(/outside the project/)
  })

  it('refuses a directory under a real configuration directory even inside the temporary directory', () => {
    const config = join(temp, 'config')
    mkdirSync(config)
    const env = { HOME: home, XDG_CONFIG_HOME: config, [SCREENSHOT_DIR_VARIABLE]: join(config, 'shots') }
    expect(() => screenshotDir(env, places())).toThrow(/real configuration directory/)
  })
})

describe('screenshotPath', () => {
  it('replaces a link at the name instead of writing through it', () => {
    const target = join(home, '.config', 'pipette-desktop', 'config.json')
    writeFileSync(target, 'real')
    const dir = join(temp, 'shots')
    mkdirSync(dir)
    symlinkSync(target, join(dir, 'a.png'))
    const path = screenshotPath(dir, 'a.png')
    expect(path).toBe(join(dir, 'a.png'))
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('real')
  })

  it('keeps a file, refuses a directory and a name that is not a plain file name', () => {
    const dir = join(temp, 'shots')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'b.png'), 'old')
    expect(lstatSync(screenshotPath(dir, 'b.png')).isFile()).toBe(true)
    expect(() => screenshotPath(dir, 'sub')).toThrow(/not a file/)
    expect(() => screenshotPath(dir, '../c.png')).toThrow(/plain file name/)
    expect(() => screenshotPath(dir, '..')).toThrow(/plain file name/)
  })
})
