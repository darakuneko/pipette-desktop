// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      key === 'i18n.missingKeys.group' ? `${String(opts?.name)} (${String(opts?.n)})` : key,
  }),
}))

const downloadJson = vi.fn()
vi.mock('../../../utils/download-json', () => ({
  downloadJson: (...args: unknown[]) => downloadJson(...args),
}))

import { MissingKeysModal } from '../MissingKeysModal'

const MISSING = [
  'common.cancel',
  'common.save',
  'keycodeTooltip.KC_A',
  'keycodeTooltip.layer.MO',
  'keycodeTooltip.user',
]
const BASE = {
  common: { cancel: 'Cancel', save: 'Save' },
  keycodeTooltip: { KC_A: 'A', layer: { MO: 'Momentary' }, user: 'User keycode {{index}}' },
}

function renderModal(missingKeys: readonly string[] = MISSING): void {
  render(<MissingKeysModal open onClose={() => {}} packName="Pack" missingKeys={missingKeys} base={BASE} />)
}

beforeEach(() => {
  downloadJson.mockClear()
})

describe('MissingKeysModal grouping', () => {
  it('groups keys by their top-level segment with a count, collapsed by default', () => {
    renderModal()
    const list = screen.getByTestId('missing-keys-modal-list')
    const headers = within(list).getAllByRole('button')
    expect(headers).toEqual([
      within(list).getByRole('button', { name: 'common (2)' }),
      within(list).getByRole('button', { name: 'keycodeTooltip (3)' }),
    ])
    for (const header of headers) expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(within(list).queryByText('common.save')).toBeNull()
  })

  it('shows the full key paths of a group when it is opened, and hides them again', () => {
    renderModal()
    const header = screen.getByRole('button', { name: 'keycodeTooltip (3)' })
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('keycodeTooltip.layer.MO')).toBeInTheDocument()
    expect(screen.getByText('keycodeTooltip.user')).toBeInTheDocument()
    expect(screen.queryByText('common.save')).toBeNull()
    fireEvent.click(header)
    expect(screen.queryByText('keycodeTooltip.layer.MO')).toBeNull()
  })

  it('puts a key without a dot in its own group', () => {
    renderModal(['common.save', 'standalone'])
    const header = screen.getByRole('button', { name: 'standalone (1)' })
    fireEvent.click(header)
    expect(screen.getByText('standalone', { selector: 'li' })).toBeInTheDocument()
  })

  it('collapses every group again when the modal is reopened', () => {
    const props = { onClose: () => {}, packName: 'Pack', missingKeys: MISSING, base: BASE }
    const { rerender } = render(<MissingKeysModal open {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'common (2)' }))
    expect(screen.getByText('common.save')).toBeInTheDocument()
    rerender(<MissingKeysModal open={false} {...props} />)
    rerender(<MissingKeysModal open {...props} />)
    expect(screen.getByRole('button', { name: 'common (2)' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('common.save')).toBeNull()
  })

  it('shows the empty message when nothing is missing', () => {
    renderModal([])
    expect(screen.getByTestId('missing-keys-modal-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('missing-keys-modal-list')).toBeNull()
  })

  it('exports every missing key regardless of which groups are open', () => {
    renderModal()
    fireEvent.click(screen.getByTestId('missing-keys-modal-export'))
    expect(downloadJson).toHaveBeenCalledTimes(1)
    const payload = downloadJson.mock.calls[0][1] as Record<string, unknown>
    expect(payload.common).toEqual({ cancel: 'Cancel', save: 'Save' })
    expect(payload.keycodeTooltip).toEqual(BASE.keycodeTooltip)
  })
})
