// SPDX-License-Identifier: GPL-2.0-or-later
// Writes the bundled provider defaults the pipette-typing-datasets crate
// includes: TYPING_TEST_PROVIDER_DEFAULTS of
// src/shared/data/typing-test-providers.ts (with the monkeytype manifest of
// language-manifest.json in it), as two-space indented JSON. CI runs this
// and fails when the committed file differs, so the crate never ships other
// defaults than the Electron build.
//
// Run: pnpm run generate:typing-dataset-fixtures

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { TYPING_TEST_PROVIDER_DEFAULTS } from '../../src/shared/data/typing-test-providers'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-typing-datasets/data/provider-defaults.json')

describe('provider defaults', () => {
  it('writes TYPING_TEST_PROVIDER_DEFAULTS', () => {
    writeJsonFixture(OUT, TYPING_TEST_PROVIDER_DEFAULTS)
    expect(TYPING_TEST_PROVIDER_DEFAULTS.map((p) => p.provider)).toContain('monkeytype')
  })
})
