// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest'
import { createVialApi } from '../stub-proxy'
import { startupApi } from '../startup-api'
import { DEFAULT_APP_CONFIG } from '../../shared/types/app-config'

describe('createVialApi', () => {
  it('returns implemented members as given', async () => {
    const listDevices = vi.fn(() => Promise.resolve([]))
    const api = createVialApi({ listDevices })
    expect(api.listDevices).toBe(listDevices)
    await expect(api.listDevices()).resolves.toEqual([])
  })

  it('resolves unimplemented request members with undefined', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const api = createVialApi({})
    await expect(api.snapshotStoreList('uid')).resolves.toBeUndefined()
    debug.mockRestore()
  })

  it('returns an unsubscribe function from unimplemented listener members', () => {
    const api = createVialApi({})
    for (const unsubscribe of [
      api.syncOnProgress(() => {}),
      api.i18nPackOnChanged(() => {}),
      api.onWindowVisibilityChanged(() => {}),
    ]) {
      expect(typeof unsubscribe).toBe('function')
      expect(unsubscribe()).toBeUndefined()
    }
  })

  it('returns the same stub on every read', () => {
    const api = createVialApi({})
    expect(api.syncOnProgress).toBe(api.syncOnProgress)
    expect(api.pipetteSettingsGet).toBe(api.pipetteSettingsGet)
  })
})

describe('startupApi', () => {
  it('answers the startup calls with the values of a fresh install', async () => {
    const api = createVialApi(startupApi)
    await expect(api.appConfigGetAll()).resolves.toEqual(DEFAULT_APP_CONFIG)
    await expect(api.listDevices()).resolves.toEqual([])
    await expect(api.syncAuthStatus()).resolves.toEqual({ authenticated: false })
    await expect(api.syncFormatStatus()).resolves.toBeNull()
    await expect(api.i18nPackList()).resolves.toEqual({ success: true, data: [] })
    await expect(api.windowIsVisible()).resolves.toBe(true)
  })
})
