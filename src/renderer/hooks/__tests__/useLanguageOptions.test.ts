// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLanguageOptions } from '../useLanguageOptions'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'

function meta(over: Partial<I18nPackMeta> & { id: string; name: string }): I18nPackMeta {
  return {
    filename: `${over.id}.json`,
    version: '0.1.0',
    enabled: true,
    savedAt: 'now',
    updatedAt: 'now',
    ...over,
  }
}

describe('useLanguageOptions', () => {
  it('falls back to the static built-in English entry before metas have loaded', () => {
    const { result } = renderHook(() => useLanguageOptions([]))
    expect(result.current).toEqual([{ id: 'builtin:en', name: 'English' }])
  })

  it('derives built-in English from the real store entry, in store order — not hardcoded first', () => {
    const metas = [
      meta({ id: 'p1', name: 'Japanese' }),
      meta({ id: 'builtin-english', name: 'English' }),
      meta({ id: 'p2', name: 'French' }),
    ]
    const { result } = renderHook(() => useLanguageOptions(metas))
    expect(result.current).toEqual([
      { id: 'pack:p1', name: 'Japanese' },
      { id: 'builtin:en', name: 'English' },
      { id: 'pack:p2', name: 'French' },
    ])
  })

  it('does not list built-in English twice when it is present in metas', () => {
    const metas = [meta({ id: 'builtin-english', name: 'English' })]
    const { result } = renderHook(() => useLanguageOptions(metas))
    expect(result.current).toEqual([{ id: 'builtin:en', name: 'English' }])
  })

  it('skips deleted and disabled packs (falling back to the static builtin entry since no real builtin-english meta is present)', () => {
    const metas = [
      meta({ id: 'del1', name: 'Deleted', deletedAt: '2026-01-01' }),
      meta({ id: 'off1', name: 'Disabled', enabled: false }),
      meta({ id: 'p1', name: 'Kept' }),
    ]
    const { result } = renderHook(() => useLanguageOptions(metas))
    expect(result.current).toEqual([
      { id: 'pack:p1', name: 'Kept' },
      { id: 'builtin:en', name: 'English' },
    ])
  })
})
