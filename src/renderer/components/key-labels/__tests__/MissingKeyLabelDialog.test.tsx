// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MissingKeyLabelDialog } from '../MissingKeyLabelDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params && 'name' in params) return `${key}:${String(params.name)}`
      return key
    },
  }),
}))

describe('MissingKeyLabelDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <MissingKeyLabelDialog open={false} missingName="brazilian" onClose={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the missing name in the message', () => {
    render(
      <MissingKeyLabelDialog
        open
        missingName="brazilian"
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('missing-key-label-dialog')).toBeTruthy()
    expect(screen.getByText('keyLabels.missingMessage:brazilian')).toBeTruthy()
    expect(screen.getByText('keyLabels.missingHint:brazilian')).toBeTruthy()
  })

  it('Close button fires onClose', () => {
    const onClose = vi.fn()
    render(<MissingKeyLabelDialog open missingName="x" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('missing-key-label-close-button'))
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking the backdrop fires onClose', () => {
    const onClose = vi.fn()
    render(<MissingKeyLabelDialog open missingName="x" onClose={onClose} />)
    fireEvent.click(screen.getByTestId('missing-key-label-backdrop'))
    expect(onClose).toHaveBeenCalled()
  })
})
