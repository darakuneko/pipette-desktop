// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useHubSearchList, type UseHubSearchListOptions } from '../useHubSearchList'

interface Item {
  id: string
  name: string
}

function baseOptions(overrides: Partial<UseHubSearchListOptions<Item>> = {}): UseHubSearchListOptions<Item> {
  return {
    open: true,
    activeTab: 'hub',
    hubTabId: 'hub',
    fetchPage: vi.fn().mockResolvedValue({ success: true, data: { items: [] } }),
    errorMessage: (error) => error ?? 'fallback error',
    onSearchStart: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

describe('useHubSearchList', () => {
  describe('name sort (Phase 3 — ported from Key Labels\' buildHubRows)', () => {
    it('sorts results by name (locale-aware, case-insensitive) regardless of server order', async () => {
      const fetchPage = vi.fn().mockResolvedValue({
        success: true,
        data: { items: [{ id: 'z', name: 'zeta' }, { id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }] },
      })
      const { result } = renderHook(
        (props: UseHubSearchListOptions<Item>) => useHubSearchList(props),
        { initialProps: baseOptions({ fetchPage }) },
      )
      await waitFor(() => expect(result.current.hubResults.map((i) => i.id)).toEqual(['a', 'm', 'z']))
    })
  })

  describe('markSearchedOnFailure policy (P1)', () => {
    it('i18n/theme policy (default false): a failed initial fetch does NOT mark hubSearched, so leaving and re-entering the Hub tab retries', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ success: false, error: 'nope' })
      const onError = vi.fn()
      const { result, rerender } = renderHook(
        (props: UseHubSearchListOptions<Item>) => useHubSearchList(props),
        { initialProps: baseOptions({ fetchPage, onError }) },
      )

      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
      expect(result.current.hubSearched).toBe(false)
      expect(onError).toHaveBeenCalledWith('nope')

      // Leave the Hub tab, then come back.
      rerender(baseOptions({ fetchPage, onError, activeTab: 'installed' }))
      rerender(baseOptions({ fetchPage, onError, activeTab: 'hub' }))

      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2))
    })

    it('Key Labels policy (true): a failed initial fetch marks hubSearched, so leaving and re-entering the Hub tab does NOT retry', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ success: false, error: 'nope' })
      const onError = vi.fn()
      const { result, rerender } = renderHook(
        (props: UseHubSearchListOptions<Item>) => useHubSearchList(props),
        { initialProps: baseOptions({ fetchPage, onError, markSearchedOnFailure: true }) },
      )

      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
      expect(result.current.hubSearched).toBe(true)

      rerender(baseOptions({ fetchPage, onError, markSearchedOnFailure: true, activeTab: 'installed' }))
      rerender(baseOptions({ fetchPage, onError, markSearchedOnFailure: true, activeTab: 'hub' }))

      // No second call — hubSearched already true blocks the auto-fetch guard.
      await new Promise((r) => setTimeout(r, 10))
      expect(fetchPage).toHaveBeenCalledTimes(1)
    })

    it('a successful initial fetch marks hubSearched under both policies (no re-fetch on tab re-entry)', async () => {
      const fetchPage = vi.fn().mockResolvedValue({ success: true, data: { items: [{ id: 'a', name: 'A' }] } })
      const { result, rerender } = renderHook(
        (props: UseHubSearchListOptions<Item>) => useHubSearchList(props),
        { initialProps: baseOptions({ fetchPage }) },
      )

      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
      expect(result.current.hubSearched).toBe(true)
      expect(result.current.hubResults).toEqual([{ id: 'a', name: 'A' }])

      rerender(baseOptions({ fetchPage, activeTab: 'installed' }))
      rerender(baseOptions({ fetchPage, activeTab: 'hub' }))

      await new Promise((r) => setTimeout(r, 10))
      expect(fetchPage).toHaveBeenCalledTimes(1)
    })
  })

  describe('rejected fetchPage (P2 — intentional deviation)', () => {
    it('routes a rejection through onError/errorMessage instead of leaving hubSearching stuck', async () => {
      const fetchPage = vi.fn().mockRejectedValue(new Error('network exploded'))
      const errorMessage = vi.fn((error: string | undefined) => `translated: ${error ?? 'unknown'}`)
      const onError = vi.fn()
      const { result } = renderHook(
        (props: UseHubSearchListOptions<Item>) => useHubSearchList(props),
        { initialProps: baseOptions({ fetchPage, errorMessage, onError }) },
      )

      await waitFor(() => expect(onError).toHaveBeenCalledWith('translated: network exploded'))
      expect(errorMessage).toHaveBeenCalledWith('network exploded')
      // The spinner must not get stuck — this is the latent bug the
      // try/finally + inner try/catch fixes for Key Labels.
      await waitFor(() => expect(result.current.hubSearching).toBe(false))
    })

    it('respects clearResultsOnError on a rejection (Key Labels clears; i18n/theme keep stale results)', async () => {
      const staleThenReject = vi.fn()
        .mockResolvedValueOnce({ success: true, data: { items: [{ id: 'stale', name: 'Stale' }] } })
        .mockRejectedValueOnce(new Error('boom'))

      const { result, rerender } = renderHook(
        (props: UseHubSearchListOptions<Item>) => useHubSearchList(props),
        { initialProps: baseOptions({ fetchPage: staleThenReject, clearResultsOnError: true }) },
      )
      await waitFor(() => expect(result.current.hubResults).toEqual([{ id: 'stale', name: 'Stale' }]))

      // Force a second run (debounce path) that rejects.
      await result.current.runSearch('query')
      rerender(baseOptions({ fetchPage: staleThenReject, clearResultsOnError: true }))
      await waitFor(() => expect(result.current.hubResults).toEqual([]))
    })

    it('respects markSearchedOnFailure on a rejection', async () => {
      const fetchPage = vi.fn().mockRejectedValue(new Error('boom'))
      const { result } = renderHook(
        (props: UseHubSearchListOptions<Item>) => useHubSearchList(props),
        { initialProps: baseOptions({ fetchPage, markSearchedOnFailure: true }) },
      )
      await waitFor(() => expect(result.current.hubSearched).toBe(true))
    })
  })
})
