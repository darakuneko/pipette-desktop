// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { PackHubActions, type PackHubActionsProps } from '../PackHubActions'

function baseProps(overrides: Partial<PackHubActionsProps> = {}): PackHubActionsProps {
  return {
    id: 'p1',
    testidPrefix: 'theme-packs',
    busy: false,
    showOpen: false,
    onOpen: vi.fn(),
    showUpload: false,
    onUpload: vi.fn(),
    showSync: false,
    hasUpdateAvailable: false,
    onSync: vi.fn(),
    showUpdateRemove: false,
    confirmingRemove: false,
    onUpdate: vi.fn(),
    onAskRemove: vi.fn(),
    onCancelRemove: vi.fn(),
    onConfirmRemove: vi.fn(),
    ...overrides,
  }
}

describe('PackHubActions', () => {
  it('renders nothing when every show* flag is false', () => {
    const { container } = render(<PackHubActions {...baseProps()} />)
    expect(container.querySelectorAll('button').length).toBe(0)
  })

  it('renders Open only when showOpen, and calls onOpen', () => {
    const onOpen = vi.fn()
    render(<PackHubActions {...baseProps({ showOpen: true, onOpen })} />)
    fireEvent.click(screen.getByTestId('theme-packs-open-p1'))
    expect(onOpen).toHaveBeenCalled()
  })

  it('renders Upload only when showUpload, and calls onUpload', () => {
    const onUpload = vi.fn()
    render(<PackHubActions {...baseProps({ showUpload: true, onUpload })} />)
    fireEvent.click(screen.getByTestId('theme-packs-upload-p1'))
    expect(onUpload).toHaveBeenCalled()
  })

  it('renders Sync (with the update-available dot) only when showSync + hasUpdateAvailable', () => {
    render(<PackHubActions {...baseProps({ showSync: true, hasUpdateAvailable: true })} />)
    expect(screen.getByTestId('theme-packs-sync-p1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-update-available-p1')).toBeTruthy()
  })

  it('hides the update-available dot when hasUpdateAvailable is false', () => {
    render(<PackHubActions {...baseProps({ showSync: true, hasUpdateAvailable: false })} />)
    expect(screen.getByTestId('theme-packs-sync-p1')).toBeTruthy()
    expect(screen.queryByTestId('theme-packs-update-available-p1')).toBeNull()
  })

  it('does not render Sync when showUpdateRemove is also true (mutually exclusive in practice)', () => {
    render(<PackHubActions {...baseProps({ showSync: false, showUpdateRemove: true })} />)
    expect(screen.queryByTestId('theme-packs-sync-p1')).toBeNull()
    expect(screen.getByTestId('theme-packs-update-p1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-remove-p1')).toBeTruthy()
  })

  it('Update/Remove swap for Confirm/Cancel when confirmingRemove', () => {
    const onConfirmRemove = vi.fn()
    const onCancelRemove = vi.fn()
    render(
      <PackHubActions
        {...baseProps({ showUpdateRemove: true, confirmingRemove: true, onConfirmRemove, onCancelRemove })}
      />,
    )
    expect(screen.queryByTestId('theme-packs-update-p1')).toBeNull()
    expect(screen.queryByTestId('theme-packs-remove-p1')).toBeNull()
    fireEvent.click(screen.getByTestId('theme-packs-confirm-remove-p1'))
    expect(onConfirmRemove).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('theme-packs-cancel-remove-p1'))
    expect(onCancelRemove).toHaveBeenCalled()
  })

  it('uses the testidPrefix for every rendered button (Language Packs prefix)', () => {
    render(<PackHubActions {...baseProps({ testidPrefix: 'language-packs', showOpen: true, showUpload: true })} />)
    expect(screen.getByTestId('language-packs-open-p1')).toBeTruthy()
    expect(screen.getByTestId('language-packs-upload-p1')).toBeTruthy()
  })

  it('disables Update/Remove/Ask-Remove while busy but not Cancel', () => {
    render(<PackHubActions {...baseProps({ showUpdateRemove: true, busy: true })} />)
    expect((screen.getByTestId('theme-packs-update-p1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('theme-packs-remove-p1') as HTMLButtonElement).disabled).toBe(true)
  })

  // --- canWrite (Key Labels convergence) ---

  it('canWrite defaults to true: Upload/Update/Remove stay enabled when omitted', () => {
    render(<PackHubActions {...baseProps({ showUpload: true, showUpdateRemove: true })} />)
    expect((screen.getByTestId('theme-packs-upload-p1') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('theme-packs-update-p1') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('theme-packs-remove-p1') as HTMLButtonElement).disabled).toBe(false)
  })

  it('canWrite=false disables Upload/Update/Remove but keeps them visible, and never disables Open/Sync', () => {
    render(
      <PackHubActions
        {...baseProps({ testidPrefix: 'key-labels', showOpen: true, showUpload: true, canWrite: false })}
      />,
    )
    expect(screen.getByTestId('key-labels-open-p1')).toBeTruthy()
    expect((screen.getByTestId('key-labels-open-p1') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('key-labels-upload-p1') as HTMLButtonElement).disabled).toBe(true)
  })

  it('canWrite=false disables Update/Remove but keeps them visible (Key Labels shows-disabled semantics)', () => {
    render(
      <PackHubActions
        {...baseProps({ testidPrefix: 'key-labels', showUpdateRemove: true, canWrite: false })}
      />,
    )
    expect((screen.getByTestId('key-labels-update-p1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('key-labels-remove-p1') as HTMLButtonElement).disabled).toBe(true)
  })

  it('canWrite=false also disables the Confirm-Remove button but not Cancel', () => {
    render(
      <PackHubActions
        {...baseProps({ testidPrefix: 'key-labels', showUpdateRemove: true, confirmingRemove: true, canWrite: false })}
      />,
    )
    expect((screen.getByTestId('key-labels-confirm-remove-p1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('key-labels-cancel-remove-p1') as HTMLButtonElement).disabled).toBe(false)
  })

  // --- hideOthersWhileConfirmingRemove (Key Labels convergence) ---

  it('hideOthersWhileConfirmingRemove defaults to false: Open stays visible during Remove confirmation', () => {
    render(
      <PackHubActions
        {...baseProps({ showOpen: true, showUpdateRemove: true, confirmingRemove: true })}
      />,
    )
    expect(screen.getByTestId('theme-packs-open-p1')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-confirm-remove-p1')).toBeTruthy()
  })

  it('hideOthersWhileConfirmingRemove hides Open/Upload/Sync while confirming, showing only Confirm/Cancel', () => {
    render(
      <PackHubActions
        {...baseProps({
          testidPrefix: 'key-labels',
          showOpen: true,
          showUpdateRemove: true,
          confirmingRemove: true,
          hideOthersWhileConfirmingRemove: true,
        })}
      />,
    )
    expect(screen.queryByTestId('key-labels-open-p1')).toBeNull()
    expect(screen.getByTestId('key-labels-confirm-remove-p1')).toBeTruthy()
    expect(screen.getByTestId('key-labels-cancel-remove-p1')).toBeTruthy()
  })

  it('hideOthersWhileConfirmingRemove has no effect outside the confirming state', () => {
    render(
      <PackHubActions
        {...baseProps({
          testidPrefix: 'key-labels',
          showOpen: true,
          showUpdateRemove: true,
          confirmingRemove: false,
          hideOthersWhileConfirmingRemove: true,
        })}
      />,
    )
    expect(screen.getByTestId('key-labels-open-p1')).toBeTruthy()
    expect(screen.getByTestId('key-labels-update-p1')).toBeTruthy()
    expect(screen.getByTestId('key-labels-remove-p1')).toBeTruthy()
  })
})
