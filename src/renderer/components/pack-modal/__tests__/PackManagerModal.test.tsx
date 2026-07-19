// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { PackManagerModal, type PackManagerModalProps } from '../PackManagerModal'
import type { PackManagerTabId } from '../pack-modal-types'

const TESTIDS: PackManagerModalProps['testids'] = {
  backdrop: 'test-backdrop',
  modal: 'test-modal',
  closeButton: 'test-close',
  tabsContainer: 'test-tabs',
  tabInstalled: 'test-tab-installed',
  tabHub: 'test-tab-hub',
  searchInput: 'test-search-input',
  searchButton: 'test-search-button',
  importButton: 'test-import-button',
  errorBanner: 'test-error',
}

function renderShell(overrides: Partial<PackManagerModalProps> = {}) {
  const props: PackManagerModalProps = {
    open: true,
    onClose: vi.fn(),
    title: 'Test Packs',
    testids: TESTIDS,
    activeTab: 'installed',
    onTabChange: vi.fn(),
    installedLabel: 'Installed',
    hubLabel: 'Find on Hub',
    search: '',
    onSearchChange: vi.fn(),
    onSearchEnter: vi.fn(),
    onSearchClick: vi.fn(),
    searchPlaceholder: 'Search…',
    searchButtonLabel: 'Search',
    searchDisabled: false,
    importLabel: 'Import',
    onImport: vi.fn(),
    sortButton: <button data-testid="test-sort-button">Name</button>,
    actionError: null,
    children: <div data-testid="body-content">body</div>,
    ...overrides,
  }
  return { props, ...render(<PackManagerModal {...props} />) }
}

describe('PackManagerModal', () => {
  it('renders nothing when closed', () => {
    const { container } = renderShell({ open: false })
    expect(container.firstChild).toBeNull()
  })

  it('renders the backdrop, modal, title and body slot when open', () => {
    renderShell()
    expect(screen.getByTestId('test-backdrop')).toBeTruthy()
    expect(screen.getByTestId('test-modal')).toBeTruthy()
    expect(screen.getByText('Test Packs')).toBeTruthy()
    expect(screen.getByTestId('body-content')).toBeTruthy()
  })

  it('shows the installed toolbar (Name sort + Import) on the installed tab and hides the search bar', () => {
    renderShell({ activeTab: 'installed' })
    expect(screen.getByTestId('test-sort-button')).toBeTruthy()
    expect(screen.getByTestId('test-import-button')).toBeTruthy()
    expect(screen.queryByTestId('test-search-input')).toBeNull()
  })

  it('shows the hub search bar on the hub tab and hides the installed toolbar', () => {
    renderShell({ activeTab: 'hub' })
    expect(screen.getByTestId('test-search-input')).toBeTruthy()
    expect(screen.getByTestId('test-search-button')).toBeTruthy()
    expect(screen.queryByTestId('test-import-button')).toBeNull()
    expect(screen.queryByTestId('test-sort-button')).toBeNull()
  })

  it('clicking the tab buttons calls onTabChange with the target tab', () => {
    const onTabChange = vi.fn()
    renderShell({ activeTab: 'installed', onTabChange })
    fireEvent.click(screen.getByTestId('test-tab-hub'))
    expect(onTabChange).toHaveBeenCalledWith('hub')
    fireEvent.click(screen.getByTestId('test-tab-installed'))
    expect(onTabChange).toHaveBeenCalledWith('installed' satisfies PackManagerTabId)
  })

  it('wires the search input/button to onSearchChange/onSearchEnter/onSearchClick', () => {
    const onSearchChange = vi.fn()
    const onSearchEnter = vi.fn()
    const onSearchClick = vi.fn()
    renderShell({ activeTab: 'hub', onSearchChange, onSearchEnter, onSearchClick })
    fireEvent.change(screen.getByTestId('test-search-input'), { target: { value: 'abc' } })
    expect(onSearchChange).toHaveBeenCalledWith('abc')
    fireEvent.keyDown(screen.getByTestId('test-search-input'), { key: 'Enter' })
    expect(onSearchEnter).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('test-search-button'))
    expect(onSearchClick).toHaveBeenCalled()
  })

  it('does not call onSearchEnter for non-Enter keys', () => {
    const onSearchEnter = vi.fn()
    renderShell({ activeTab: 'hub', onSearchEnter })
    fireEvent.keyDown(screen.getByTestId('test-search-input'), { key: 'a' })
    expect(onSearchEnter).not.toHaveBeenCalled()
  })

  it('disables the search button per searchDisabled', () => {
    renderShell({ activeTab: 'hub', searchDisabled: true })
    expect((screen.getByTestId('test-search-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls onImport when the Import button is clicked', () => {
    const onImport = vi.fn()
    renderShell({ activeTab: 'installed', onImport })
    fireEvent.click(screen.getByTestId('test-import-button'))
    expect(onImport).toHaveBeenCalled()
  })

  it('shows the error banner with its testid when actionError is set', () => {
    renderShell({ actionError: 'Something broke' })
    expect(screen.getByTestId('test-error').textContent).toBe('Something broke')
  })

  it('omits the error banner testid when none is provided (Key Labels behaviour)', () => {
    const testidsNoBanner = { ...TESTIDS, errorBanner: undefined }
    renderShell({ actionError: 'oops', testids: testidsNoBanner })
    expect(screen.queryByTestId('test-error')).toBeNull()
    expect(screen.getByText('oops')).toBeTruthy()
  })

  it('renders afterContent as a portal sibling (Language Packs MissingKeysModal slot)', () => {
    renderShell({ afterContent: <div data-testid="after-content">extra</div> })
    expect(screen.getByTestId('after-content')).toBeTruthy()
  })

  it('backdrop click calls onClose', () => {
    const onClose = vi.fn()
    renderShell({ onClose })
    fireEvent.click(screen.getByTestId('test-backdrop'))
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking inside the modal box does not call onClose', () => {
    const onClose = vi.fn()
    renderShell({ onClose })
    fireEvent.click(screen.getByTestId('test-modal'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('close button calls onClose', () => {
    const onClose = vi.fn()
    renderShell({ onClose })
    fireEvent.click(screen.getByTestId('test-close'))
    expect(onClose).toHaveBeenCalled()
  })
})
