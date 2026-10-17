// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest'
import { createVialApi } from '../create-vial-api'
import { implemented } from '../implemented'
import { VIAL_API_MEMBER_NAMES } from '../vial-api-members'
import { DEFAULT_APP_CONFIG } from '../../shared/types/app-config'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

describe('createVialApi', () => {
  it('has every VialAPI member as an own property', () => {
    const api = createVialApi({})
    expect(Object.keys(api).sort()).toEqual([...VIAL_API_MEMBER_NAMES].sort())
    for (const name of VIAL_API_MEMBER_NAMES) {
      expect(typeof api[name]).toBe('function')
    }
  })

  it('returns implemented members as given', async () => {
    const listDevices = vi.fn(() => Promise.resolve([]))
    const api = createVialApi({ listDevices })
    expect(api.listDevices).toBe(listDevices)
    await expect(api.listDevices()).resolves.toEqual([])
  })

  it('resolves unimplemented request members with undefined, warning once per member', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = createVialApi({})
    await expect(api.snapshotStoreList('uid')).resolves.toBeUndefined()
    await expect(api.snapshotStoreList('uid')).resolves.toBeUndefined()
    await expect(api.pipetteSettingsGet('uid')).resolves.toBeUndefined()
    expect(warn.mock.calls).toEqual([
      ['[vialAPI shim] snapshotStoreList is not implemented'],
      ['[vialAPI shim] pipetteSettingsGet is not implemented'],
    ])
  })

  it('returns an unsubscribe function from unimplemented listener members', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = createVialApi({})
    for (const unsubscribe of [
      api.syncOnProgress(() => {}),
      api.syncOnPendingChange(() => {}),
      api.i18nPackOnChanged(() => {}),
      api.onWindowVisibilityChanged(() => {}),
    ]) {
      expect(typeof unsubscribe).toBe('function')
      expect(unsubscribe()).toBeUndefined()
    }
  })

  it('returns the same function on every read', () => {
    const api = createVialApi({})
    expect(api.syncOnProgress).toBe(api.syncOnProgress)
    expect(api.pipetteSettingsGet).toBe(api.pipetteSettingsGet)
  })
})

describe('implemented', () => {
  it('asks the backend for the sync format status', async () => {
    invoke.mockResolvedValueOnce(null)
    const api = createVialApi(implemented)
    await expect(api.syncFormatStatus()).resolves.toBeNull()
    expect(invoke).toHaveBeenLastCalledWith('sync_format_status', undefined)
  })

  it('asks the backend for the sync sign-in status', async () => {
    invoke.mockResolvedValueOnce({ authenticated: false })
    const api = createVialApi(implemented)
    await expect(api.syncAuthStatus()).resolves.toEqual({ authenticated: false })
    expect(invoke).toHaveBeenLastCalledWith('sync_auth_status', undefined)
  })

  it('asks the backend for the Hub requests of the language and theme packs', async () => {
    const api = createVialApi(implemented)
    const failed = { success: false, error: 'offline' }
    invoke.mockResolvedValueOnce(failed)
    await expect(api.i18nPackHubTimestamps(['post-1'])).resolves.toEqual(failed)
    expect(invoke).toHaveBeenLastCalledWith('i18n_pack_hub_timestamps', { ids: ['post-1'] })
    invoke.mockResolvedValueOnce(failed)
    await expect(api.hubUploadThemePost({ entryId: 'id', pack: {} as never })).resolves.toEqual(failed)
    expect(invoke).toHaveBeenLastCalledWith('hub_upload_theme_post', { params: { entryId: 'id' }, pack: '{}' })
  })

  it('asks the backend for the run logs of a keyboard', async () => {
    invoke.mockResolvedValueOnce({ success: true, entries: [] })
    const api = createVialApi(implemented)
    await expect(api.typingRunLogList('uid')).resolves.toEqual({ success: true, entries: [] })
    expect(invoke).toHaveBeenCalledWith('typing_run_log_list', { uid: 'uid' })
  })

  it('asks the backend for the app config', async () => {
    invoke.mockResolvedValueOnce(DEFAULT_APP_CONFIG)
    const api = createVialApi(implemented)
    await expect(api.appConfigGetAll()).resolves.toEqual(DEFAULT_APP_CONFIG)
    expect(invoke).toHaveBeenCalledWith('app_config_get_all', undefined)
  })

  it('asks the backend for the key labels and answers the key label Hub as unavailable', async () => {
    invoke.mockResolvedValueOnce({ success: true, data: [] })
    const api = createVialApi(implemented)
    await expect(api.keyLabelStoreList()).resolves.toEqual({ success: true, data: [] })
    expect(invoke).toHaveBeenCalledWith('key_label_store_list', undefined)
    await expect(api.keyLabelHubTimestamps([])).resolves.toEqual({ success: false })
  })

  it('asks the backend for the snapshots of a keyboard', async () => {
    invoke.mockResolvedValueOnce({ success: true, entries: [] })
    const api = createVialApi(implemented)
    await expect(api.snapshotStoreList('uid')).resolves.toEqual({ success: true, entries: [] })
    expect(invoke).toHaveBeenCalledWith('snapshot_store_list', { uid: 'uid' })
  })

  it('asks the backend for the pipette settings of a keyboard', async () => {
    invoke.mockResolvedValueOnce({ content: null, etag: 'absent' })
    const api = createVialApi(implemented)
    await expect(api.pipetteSettingsGet('uid')).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledWith('pipette_settings_read', { uid: 'uid' })
  })

  it('asks the backend for devices', async () => {
    invoke.mockResolvedValueOnce([])
    const api = createVialApi(implemented)
    await expect(api.listDevices()).resolves.toEqual([])
    expect(invoke).toHaveBeenCalledWith('list_devices', undefined)
  })

  it('asks the backend for a probe handle', async () => {
    invoke.mockClear()
    invoke.mockRejectedValueOnce('Probe target device not found')
    await expect(createVialApi(implemented).probeDevice(1, 2)).rejects.toThrow('Probe target device not found')
    expect(invoke).toHaveBeenCalledWith('hid_probe_open', { vendorId: 1, productId: 2, serialNumber: undefined })
  })
})
