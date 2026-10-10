// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Covers the "why sync isn't ready" label shown in place of the plain
// "Not synced yet" text once a `syncReadinessReason` is known (Connect
// tab). Before `sync.readiness.*` existed in the locale files this
// resolved to a raw, un-translated key on screen — see
// `syncCredentialI18nKey('readiness', reason)` in SyncStatusSection.tsx.

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { SyncStatusSection } from '../SyncStatusSection'
import english from '../../../i18n/locales/english.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

describe('SyncStatusSection', () => {
  it('renders the readiness key for an unauthenticated reason instead of the generic "not synced yet" label', () => {
    render(
      <SyncStatusSection
        syncStatus="none"
        progress={null}
        lastSyncResult={null}
        syncReadinessReason="unauthenticated"
      />,
    )
    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('sync.readiness.unauthenticated')
  })

  it.each(['noPasswordFile', 'decryptFailed', 'keystoreUnavailable', 'remoteCheckFailed'] as const)(
    'renders the readiness message for %s, which english.json defines',
    (reason) => {
      render(
        <SyncStatusSection
          syncStatus="none"
          progress={null}
          lastSyncResult={null}
          syncReadinessReason={reason}
        />,
      )
      expect(screen.getByTestId('sync-status-label')).toHaveTextContent(`sync.readiness.${reason}`)
      expect(english.sync.readiness[reason]).toEqual(expect.any(String))
    },
  )

  it('falls back to "not synced yet" when no readiness reason is given', () => {
    render(
      <SyncStatusSection
        syncStatus="none"
        progress={null}
        lastSyncResult={null}
        syncReadinessReason={null}
      />,
    )
    expect(screen.getByTestId('sync-status-label')).toHaveTextContent('sync.noSyncYet')
  })
})
