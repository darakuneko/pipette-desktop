// SPDX-License-Identifier: GPL-2.0-or-later
// Shared Vitest config for the fake servers and tools under scripts/. Each
// keeps its own config file so the root config (`pnpm test`) never picks
// them up.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type TestUserConfig, type ViteUserConfig } from 'vitest/config'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Config that runs only the `*.test.ts` files under `scripts/<dir>`, with
 *  the `test` options in `extraTest` merged over the defaults. */
export function fixtureConfig(dir: string, extraTest: TestUserConfig = {}): ViteUserConfig {
  return defineConfig({
    root: REPO_ROOT,
    test: {
      include: [`scripts/${dir}/**/*.test.ts`],
      retry: 0,
      ...extraTest,
    },
  })
}
