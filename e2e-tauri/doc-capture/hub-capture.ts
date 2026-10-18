// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Hub side of the captures that show Pipette Hub (the specs wdio.conf.ts
// starts with the fake Hub of scripts/fake-hub): the app signed in to it as
// the Hub test account with a display name, and the fake Hub holding the
// language packs, theme packs and Key Labels of sample-packs/, uploaded by
// other accounts, for the Find on Hub tabs to list. Nothing reaches the real
// Hub: helpers/hub-harness.ts refuses an app that is not pointed at the fake
// one.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { browser } from '@wdio/globals'
import { readSample, SAMPLE_PACKS } from '../helpers/hub'
import { HUB_TEST_ACCOUNT } from '../helpers/hub-env'
import { assertHubSession, hubControl, hubState } from '../helpers/hub-harness'
import { editAppConfig, prepareCapture, relaunchApp } from './common'
import type { Page } from './page'

/** The display name of the Hub test account in the screenshots. */
const CAPTURE_DISPLAY_NAME = 'pipette'
/** The account the fake Hub's language and theme packs are uploaded by;
 *  its display name is the local part. */
const COMMUNITY_ACCOUNT = 'community@example.com'
/** The fake Hub's owner of the Hub's own records. */
const HUB_SYSTEM_OWNER = 'system'
const LANGUAGE_PACK_EXPORTED_AT = '2026-01-01T00:00:00.000Z'
const TOKEN_TIMEOUT_MS = 30_000

/**
 * Gives the Hub test account its display name on the fake Hub, turns the
 * Hub on in the app's config and starts the app again (running
 * `whileStopped` too, for the spec's own seed), so the app signs in to the
 * fake Hub on launch, as an app the user signed in to the Hub does. Leaves
 * the app on the device-selection screen.
 */
export async function startSignedInToHub(page: Page, whileStopped?: () => void | Promise<void>): Promise<void> {
  await assertHubSession()
  await hubControl('users', { email: HUB_TEST_ACCOUNT, displayName: CAPTURE_DISPLAY_NAME })
  await relaunchApp(async () => {
    editAppConfig((config) => {
      config.hubEnabled = true
    })
    await whileStopped?.()
  })
  await assertHubSession()
  await prepareCapture(page)
  await browser
    .waitUntil(async () => (await hubState()).tokenCached, { timeout: TOKEN_TIMEOUT_MS })
    .catch(() => console.log('  [warn] the app has not signed in to the Hub yet'))
}

/** The sample files of `kind` (a directory of sample-packs/), parsed. */
function samples(kind: 'i18n' | 'themes' | 'key-labels'): Record<string, unknown>[] {
  return readdirSync(join(SAMPLE_PACKS, kind))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readSample(`${kind}/${name}`))
}

/** Puts every sample language pack on the fake Hub. */
export async function seedHubLanguagePacks(): Promise<void> {
  for (const pack of samples('i18n')) {
    await hubControl('i18n-packs', {
      owner: COMMUNITY_ACCOUNT,
      export: { version: 1, kind: 'i18n', exportedAt: LANGUAGE_PACK_EXPORTED_AT, pack },
    })
  }
}

/** Puts every sample theme pack on the fake Hub. */
export async function seedHubThemePacks(): Promise<void> {
  for (const pack of samples('themes')) {
    await hubControl('theme-packs', { owner: COMMUNITY_ACCOUNT, pack })
  }
}

/** Puts every sample Key Label on the fake Hub as one of the Hub's own,
 *  and answers their Hub ids by name. */
export async function seedHubKeyLabels(): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const label of samples('key-labels')) {
    const { id } = await hubControl<{ id: string }>('key-labels', {
      owner: HUB_SYSTEM_OWNER,
      name: label.name,
      map: label.map,
      compositeLabels: label.composite_labels,
      keymapApplicable: label.keymap_applicable === true,
    })
    ids.set(String(label.name), id)
  }
  return ids
}
