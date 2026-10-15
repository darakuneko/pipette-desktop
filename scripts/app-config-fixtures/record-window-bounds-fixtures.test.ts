// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the main window's geometry in src-tauri
// (src/window_bounds.rs and src/window_state.rs): writes
// tests/fixtures/window-bounds.json with
// - the nominal minimum size (MIN_WIDTH / MIN_HEIGHT of src/main/app-config.ts);
// - effectiveMinSize and clampBoundsToWorkArea (src/main/window-bounds.ts)
//   over a table of work areas and bounds;
// - loadWindowState (src/main/app-config.ts) over stored windowState values
//   (the JSON text in config.json, null for no windowState key) and sets of
//   display bounds, run on the real electron-store in a temp directory.
//
// Run: pnpm run generate:app-config-fixtures

import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const state = vi.hoisted(() => ({ dir: '', displays: [] as Rect[] }))

vi.mock('electron', () => {
  const app = { getPath: () => state.dir, getVersion: () => '0.0.0' }
  const ipcMain = { on: () => undefined, handle: () => undefined }
  const screen = { getAllDisplays: () => state.displays.map((bounds) => ({ bounds })) }
  return { default: { app, ipcMain, shell: {}, screen }, app, ipcMain, screen }
})
vi.mock('../../src/main/ipc-guard', () => ({ secureHandle: () => undefined }))

import { clampBoundsToWorkArea, effectiveMinSize } from '../../src/main/window-bounds'

const FIXTURE = resolve(REPO_ROOT, 'src-tauri/tests/fixtures/window-bounds.json')

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height })

const WORK_AREAS: Rect[] = [
  rect(0, 0, 1920, 1080),
  rect(0, 25, 1440, 875),
  rect(-1920, 0, 1920, 1040),
  rect(100, 100, 320, 240),
  rect(0, 0, 1280, 1024),
  rect(2560, -200, 1080, 1920),
  rect(0.5, 24.5, 1366.5, 743.25),
]

const BOUNDS: Rect[] = [
  rect(100, 50, 1440, 1024),
  rect(50, 50, 1440, 1024),
  rect(2500, 100, 1440, 800),
  rect(1800, 1000, 1280, 1024),
  rect(-500, -300, 1280, 1024),
  rect(-100, 0, 1440, 1024),
  rect(0, 0, 1280, 1024),
  rect(10, 10, 800, 600),
  rect(-200, -50, 1920, 1080),
  rect(10.5, 20.25, 1300.5, 1000.75),
  rect(3000, 1500, 100, 100),
  rect(-1, -1, 1440, 1024),
]

const MIN_SIZES: [number, number][] = [
  [1280, 1024],
  [300, 100],
  [1, 1],
]

const DISPLAY_SETS: Record<string, Rect[]> = {
  'one display': [rect(0, 0, 1920, 1080)],
  'a display left of the primary': [rect(0, 0, 2560, 1440), rect(-1920, 180, 1920, 1080)],
  'no display': [],
}

const STORED: (string | null)[] = [
  null,
  'null',
  '"x"',
  '[]',
  '{}',
  '{"x":1,"y":2,"width":3}',
  '{"x":"1","y":2,"width":1500,"height":1100}',
  '{"x":100,"y":50,"width":1500,"height":1100}',
  '{"x":100,"y":50,"width":800,"height":600}',
  '{"x":-1,"y":-1,"width":1440,"height":1024}',
  '{"x":-1,"y":5,"width":1440,"height":1024}',
  '{"x":-1500,"y":300,"width":1400,"height":1050}',
  '{"x":5000,"y":5000,"width":1440,"height":1024}',
  '{"x":1200,"y":0,"width":1440,"height":1024}',
  '{"x":1199,"y":0,"width":1440,"height":1024}',
  '{"x":100.5,"y":50.25,"width":1500.5,"height":1100.75}',
  '{"x":0,"y":0,"width":1440,"height":1024,"extra":1}',
  '{"x":1e400,"y":0,"width":1440,"height":1024}',
  '{"x":0,"y":0,"width":1e400,"height":1024}',
]

type AppConfigModule = typeof import('../../src/main/app-config')

// Imported once the temp directory exists: electron-store opens its file in
// app.getPath('userData') when the module loads.
let appConfig: AppConfigModule

beforeAll(async () => {
  state.dir = mkdtempSync(join(tmpdir(), 'pipette-window-bounds-'))
  appConfig = await import('../../src/main/app-config')
})

afterAll(() => {
  rmSync(state.dir, { recursive: true, force: true })
})

function loadWith(stored: string | null, displays: Rect[]): Rect {
  writeFileSync(join(state.dir, 'config.json'), stored === null ? '{}' : `{"windowState":${stored}}`)
  state.displays = displays
  return appConfig.loadWindowState()
}

describe('window bounds fixtures', () => {
  it('records the geometry helpers and loadWindowState', () => {
    const { MIN_WIDTH, MIN_HEIGHT } = appConfig
    writeJsonFixture(FIXTURE, {
      minSize: { width: MIN_WIDTH, height: MIN_HEIGHT },
      effectiveMinSize: WORK_AREAS.flatMap((workArea) =>
        MIN_SIZES.map(([minWidth, minHeight]) => ({
          workArea: { width: workArea.width, height: workArea.height },
          minWidth,
          minHeight,
          result: effectiveMinSize(workArea, minWidth, minHeight),
        })),
      ),
      clampBoundsToWorkArea: WORK_AREAS.flatMap((workArea) =>
        BOUNDS.map((bounds) => ({ bounds, workArea, result: clampBoundsToWorkArea(bounds, workArea) })),
      ),
      loadWindowState: Object.entries(DISPLAY_SETS).flatMap(([name, displays]) =>
        STORED.map((stored) => ({ name, stored, displays, result: loadWith(stored, displays) })),
      ),
    })
  })
})
