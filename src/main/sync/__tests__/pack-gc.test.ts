// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRunI18nGc = vi.fn().mockResolvedValue({ purged: 0, swept: 0 })
const mockRunThemeGc = vi.fn().mockResolvedValue({ purged: 0, swept: 0 })
const mockLog = vi.fn()

vi.mock('../../i18n-pack-store', () => ({
  runGcUnderLock: (...args: unknown[]) => mockRunI18nGc(...args),
}))
vi.mock('../../theme-pack-store', () => ({
  runGcUnderLock: (...args: unknown[]) => mockRunThemeGc(...args),
}))
vi.mock('../../logger', () => ({
  log: (...args: unknown[]) => mockLog(...args),
}))

import { runPackGcAfterPass } from '../pack-gc'

describe('runPackGcAfterPass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunI18nGc.mockResolvedValue({ purged: 0, swept: 0 })
    mockRunThemeGc.mockResolvedValue({ purged: 0, swept: 0 })
  })

  it('runs the i18n store\'s single-lock GC when the pass touched an i18n unit', async () => {
    await runPackGcAfterPass(['i18n/packs/pack-a'])

    expect(mockRunI18nGc).toHaveBeenCalledTimes(1)
    expect(mockRunThemeGc).not.toHaveBeenCalled()
  })

  it('runs the theme store\'s single-lock GC when the pass touched a theme unit', async () => {
    await runPackGcAfterPass(['themes/index'])

    expect(mockRunThemeGc).toHaveBeenCalledTimes(1)
    expect(mockRunI18nGc).not.toHaveBeenCalled()
  })

  it('runs both stores when a pass touched both i18n and theme units', async () => {
    await runPackGcAfterPass(['i18n/index', 'themes/packs/theme-a'])

    expect(mockRunI18nGc).toHaveBeenCalledTimes(1)
    expect(mockRunThemeGc).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a pass with no pack units (e.g. favorites/keyboards only)', async () => {
    await runPackGcAfterPass(['favorites/tapDance', 'keyboards/uid-1/settings'])

    expect(mockRunI18nGc).not.toHaveBeenCalled()
    expect(mockRunThemeGc).not.toHaveBeenCalled()
  })

  it('does nothing for an empty list', async () => {
    await runPackGcAfterPass([])

    expect(mockRunI18nGc).not.toHaveBeenCalled()
    expect(mockRunThemeGc).not.toHaveBeenCalled()
  })

  it('never throws when one store fails — logs a unit-name-only warning and the other store still runs', async () => {
    mockRunI18nGc.mockRejectedValue(new Error('disk full'))

    await expect(runPackGcAfterPass(['i18n/index', 'themes/index'])).resolves.toBeUndefined()

    expect(mockRunThemeGc).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('i18n'))
  })

  // M3: a store's SWEEP is skipped when any of that store's own units
  // failed to merge this pass (the just-read index can't be trusted as
  // complete) — but GC still runs (purge is index-only and safe).
  describe('M3: failedSyncUnits gates skipSweep per store', () => {
    it('passes skipSweep: false to both stores when nothing failed', async () => {
      await runPackGcAfterPass(['i18n/index', 'themes/index'], [])

      expect(mockRunI18nGc).toHaveBeenCalledWith({ skipSweep: false })
      expect(mockRunThemeGc).toHaveBeenCalledWith({ skipSweep: false })
    })

    it('passes skipSweep: true only to the store whose unit failed', async () => {
      await runPackGcAfterPass(['i18n/packs/pack-a', 'themes/packs/theme-a'], ['i18n/packs/pack-a'])

      expect(mockRunI18nGc).toHaveBeenCalledWith({ skipSweep: true })
      expect(mockRunThemeGc).toHaveBeenCalledWith({ skipSweep: false })
    })

    it('defaults failedSyncUnits to empty when the caller omits it', async () => {
      await runPackGcAfterPass(['i18n/index'])

      expect(mockRunI18nGc).toHaveBeenCalledWith({ skipSweep: false })
    })
  })
})
