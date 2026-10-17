// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for src-tauri/crates/pipette-hub: the Electron Hub
// IPC handlers run through the scenarios of scenarios/*.ts in the Hub
// fixture harness (hub-harness.ts), against a scripted Hub that never
// connects (record-scenario.ts). What a scenario records is described in
// handler-scenario.ts.
//
// One file per domain: ts_hub_handlers_<domain>.json. The analytics domain
// needs the typing analytics database and is recorded by
// analytics-export/record-analytics-handlers.test.ts.
//
// Run: pnpm run generate:hub-fixtures

import { afterAll, afterEach, beforeAll, describe, it } from 'vitest'
import { setAnswerActions } from './hub-harness'
import { recordDomain, restoreFetch } from './record-scenario'
import type { Scenario } from './handler-scenario'
import { ACCOUNT_SCENARIOS } from './scenarios/account'
import { POST_SCENARIOS, PRIVATE_SCENARIOS } from './scenarios/posts'
import { FAVORITE_SCENARIOS } from './scenarios/favorite'
import { I18N_PACK_SCENARIOS, THEME_PACK_SCENARIOS } from './scenarios/packs'
import { KEY_LABEL_SCENARIOS } from './scenarios/key-labels'
import { STARTUP_SYNC_SCENARIOS } from './scenarios/startup-sync'
import { setupHubIpc, clearHubTokenCache } from '../../src/main/hub/hub-ipc'

const DOMAINS: Record<string, Scenario[]> = {
  account: ACCOUNT_SCENARIOS,
  posts: POST_SCENARIOS,
  private: PRIVATE_SCENARIOS,
  favorite: FAVORITE_SCENARIOS,
  i18n_packs: I18N_PACK_SCENARIOS,
  theme_packs: THEME_PACK_SCENARIOS,
  key_labels: KEY_LABEL_SCENARIOS,
  startup_sync: STARTUP_SYNC_SCENARIOS,
}

describe('hub handler fixtures', () => {
  beforeAll(() => {
    setupHubIpc()
    setAnswerActions({ clearHubTokenCache })
  })

  afterEach(() => {
    restoreFetch()
  })

  afterAll(() => {
    setAnswerActions({})
  })

  for (const [domain, scenarios] of Object.entries(DOMAINS)) {
    it(`records the ${domain} handlers`, async () => {
      await recordDomain(domain, scenarios, { generator: 'scripts/hub-fixtures/record-hub-handler-fixtures.test.ts' })
    })
  }
})
