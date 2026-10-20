// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Rust crates build in copies of two TypeScript definitions as JSON
// (src-tauri/crates/pipette-app-config/data/defaults.json and
// src-tauri/crates/pipette-typing-datasets/data/provider-defaults.json).
// These checks fail when a definition and its copy differ.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APP_CONFIG,
  SETTABLE_APP_CONFIG_KEYS,
  ZOOM_FACTOR_DEFAULT,
  ZOOM_FACTOR_MAX,
  ZOOM_FACTOR_MIN,
} from '../types/app-config'
import { TYPING_TEST_PROVIDER_DEFAULTS } from '../data/typing-test-providers'

const CRATES = join(__dirname, '../../../src-tauri/crates')

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(CRATES, path), 'utf-8'))
}

describe('pipette-app-config data/defaults.json', () => {
  const recorded = readJson('pipette-app-config/data/defaults.json') as Record<string, unknown>

  it('holds DEFAULT_APP_CONFIG', () => {
    expect(recorded.defaults).toStrictEqual(DEFAULT_APP_CONFIG)
  })

  it('holds SETTABLE_APP_CONFIG_KEYS in order', () => {
    expect(recorded.settableKeys).toEqual([...SETTABLE_APP_CONFIG_KEYS])
  })

  it('holds the zoom factor range', () => {
    expect(recorded.zoomFactor).toEqual({ min: ZOOM_FACTOR_MIN, max: ZOOM_FACTOR_MAX, default: ZOOM_FACTOR_DEFAULT })
  })

  it('holds nothing else', () => {
    expect(Object.keys(recorded).sort()).toEqual(['defaults', 'settableKeys', 'zoomFactor'])
  })
})

describe('pipette-typing-datasets data/provider-defaults.json', () => {
  it('holds TYPING_TEST_PROVIDER_DEFAULTS', () => {
    expect(readJson('pipette-typing-datasets/data/provider-defaults.json')).toStrictEqual(TYPING_TEST_PROVIDER_DEFAULTS)
  })
})
