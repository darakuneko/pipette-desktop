// SPDX-License-Identifier: GPL-2.0-or-later
// Shared Vitest config for the fixture generators under scripts/. Each
// generator keeps its own config file so the root config (`pnpm test`)
// never picks them up and never rewrites the fixtures.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type TestUserConfig, type ViteUserConfig } from 'vitest/config'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Config that runs only the `*.test.ts` files under `scripts/<dir>`, with
 *  the `test` options in `extraTest` merged over the defaults. */
export function fixtureConfig(dir: string, extraTest: TestUserConfig = {}): ViteUserConfig {
  return defineConfig({
    root: REPO_ROOT,
    resolve: {
      alias: {
        // Same stub the root config uses: the real `electron` package throws
        // at import time outside an Electron runtime.
        electron: resolve(REPO_ROOT, 'src/main/__tests__/electron-stub.ts'),
      },
    },
    test: {
      include: [`scripts/${dir}/**/*.test.ts`],
      retry: 0,
      ...extraTest,
    },
  })
}
