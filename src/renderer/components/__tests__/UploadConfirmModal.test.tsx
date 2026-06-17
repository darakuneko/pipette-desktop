// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UploadConfirmModal } from '../hub/UploadConfirmModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

describe('UploadConfirmModal', () => {
  it('defaults to public and hides the expiry select', () => {
    render(<UploadConfirmModal request={{ mode: 'create', currentVisibility: 'none' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('upload-confirm-expiry-select')).not.toBeInTheDocument()
  })

  it('reveals the expiry select with a date preview when private is chosen', () => {
    render(<UploadConfirmModal request={{ mode: 'create', currentVisibility: 'none' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('upload-confirm-visibility-private'))
    expect(screen.getByTestId('upload-confirm-expiry-select')).toBeInTheDocument()
    expect(screen.getByTestId('upload-confirm-expiry-preview')).toBeInTheDocument()
  })

  it('returns a public choice with null expiry', () => {
    const onConfirm = vi.fn()
    render(<UploadConfirmModal request={{ mode: 'create', currentVisibility: 'none' }} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('upload-confirm-submit'))
    expect(onConfirm).toHaveBeenCalledWith({ visibility: 'public', expiresInDays: null })
  })

  it('returns a private choice with the default 7-day expiry', () => {
    const onConfirm = vi.fn()
    render(<UploadConfirmModal request={{ mode: 'create', currentVisibility: 'none' }} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('upload-confirm-visibility-private'))
    fireEvent.click(screen.getByTestId('upload-confirm-submit'))
    expect(onConfirm).toHaveBeenCalledWith({ visibility: 'private', expiresInDays: 7 })
  })

  it('lets the user pick a longer expiry (180-day max)', () => {
    const onConfirm = vi.fn()
    render(<UploadConfirmModal request={{ mode: 'create', currentVisibility: 'none' }} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('upload-confirm-visibility-private'))
    fireEvent.change(screen.getByTestId('upload-confirm-expiry-select'), { target: { value: '180' } })
    fireEvent.click(screen.getByTestId('upload-confirm-submit'))
    expect(onConfirm).toHaveBeenCalledWith({ visibility: 'private', expiresInDays: 180 })
  })

  it('initialises to private when the entry is already private (update)', () => {
    render(<UploadConfirmModal request={{ mode: 'update', currentVisibility: 'private' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('upload-confirm-expiry-select')).toBeInTheDocument()
  })

  it('shows no warning for public→public update', () => {
    render(<UploadConfirmModal request={{ mode: 'update', currentVisibility: 'public' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('upload-confirm-warning')).not.toBeInTheDocument()
  })

  it('warns when an update switches public→private (URL/expiry change)', () => {
    render(<UploadConfirmModal request={{ mode: 'update', currentVisibility: 'public' }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('upload-confirm-visibility-private'))
    expect(screen.getByTestId('upload-confirm-warning')).toBeInTheDocument()
  })

  it('calls onCancel from the cancel button', () => {
    const onCancel = vi.fn()
    render(<UploadConfirmModal request={{ mode: 'create', currentVisibility: 'none' }} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('upload-confirm-cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
