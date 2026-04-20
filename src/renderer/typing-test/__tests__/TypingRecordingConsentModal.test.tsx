// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TypingRecordingConsentModal } from '../TypingRecordingConsentModal'

describe('TypingRecordingConsentModal', () => {
  it('renders the modal with accept and cancel buttons', () => {
    render(<TypingRecordingConsentModal onAccept={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('typing-consent-modal')).toBeInTheDocument()
    expect(screen.getByTestId('typing-consent-accept')).toBeInTheDocument()
    expect(screen.getByTestId('typing-consent-cancel')).toBeInTheDocument()
  })

  it('calls onAccept when Enable is pressed', () => {
    const onAccept = vi.fn()
    render(<TypingRecordingConsentModal onAccept={onAccept} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('typing-consent-accept'))
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when Cancel is pressed', () => {
    const onCancel = vi.fn()
    render(<TypingRecordingConsentModal onAccept={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('typing-consent-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('calls onCancel when the backdrop is clicked', () => {
    const onCancel = vi.fn()
    render(<TypingRecordingConsentModal onAccept={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('typing-consent-modal'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('does not call onCancel when an inner button is clicked', () => {
    const onCancel = vi.fn()
    render(<TypingRecordingConsentModal onAccept={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('typing-consent-accept'))
    expect(onCancel).not.toHaveBeenCalled()
  })
})
