// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { PackHubResultRow } from '../PackHubResultRow'

describe('PackHubResultRow', () => {
  it('renders name, version and uploader', () => {
    render(
      <PackHubResultRow
        hubPostId="hub-1"
        testidPrefix="language-packs"
        name="French Pack"
        version="1.0"
        uploaderName="someone"
        alreadyInstalled={false}
        busy={false}
        onDownload={vi.fn()}
      />,
    )
    expect(screen.getByTestId('language-packs-hub-row-hub-1')).toBeTruthy()
    expect(screen.getByText('French Pack')).toBeTruthy()
    expect(screen.getByText('v1.0 · someone')).toBeTruthy()
  })

  it('omits the uploader separator when uploaderName is empty', () => {
    render(
      <PackHubResultRow
        hubPostId="hub-2"
        testidPrefix="language-packs"
        name="German"
        version="1.0"
        uploaderName=""
        alreadyInstalled={false}
        busy={false}
        onDownload={vi.fn()}
      />,
    )
    expect(screen.getByText('v1.0')).toBeTruthy()
  })

  it('shows the Installed badge and hides Download when alreadyInstalled', () => {
    render(
      <PackHubResultRow
        hubPostId="hub-3"
        testidPrefix="language-packs"
        name="Existing"
        version="1.0"
        uploaderName=""
        alreadyInstalled
        busy={false}
        onDownload={vi.fn()}
      />,
    )
    expect(screen.getByText('common.installed')).toBeTruthy()
    expect(screen.queryByTestId('language-packs-hub-download-hub-3')).toBeNull()
  })

  it('shows Download and calls onDownload when not installed', () => {
    const onDownload = vi.fn()
    render(
      <PackHubResultRow
        hubPostId="hub-4"
        testidPrefix="theme-packs"
        name="New"
        version="1.0"
        uploaderName=""
        alreadyInstalled={false}
        busy={false}
        onDownload={onDownload}
      />,
    )
    fireEvent.click(screen.getByTestId('theme-packs-hub-download-hub-4'))
    expect(onDownload).toHaveBeenCalled()
  })

  it('disables Download while busy', () => {
    render(
      <PackHubResultRow
        hubPostId="hub-5"
        testidPrefix="theme-packs"
        name="New"
        version="1.0"
        uploaderName=""
        alreadyInstalled={false}
        busy
        onDownload={vi.fn()}
      />,
    )
    expect((screen.getByTestId('theme-packs-hub-download-hub-5') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders leadingActions (Theme Packs\' Preview button) before the Installed/Download slot', () => {
    render(
      <PackHubResultRow
        hubPostId="hub-6"
        testidPrefix="theme-packs"
        name="Retro"
        version="1.0"
        uploaderName=""
        alreadyInstalled={false}
        busy={false}
        onDownload={vi.fn()}
        leadingActions={<button data-testid="theme-packs-hub-preview-hub-6">preview</button>}
      />,
    )
    expect(screen.getByTestId('theme-packs-hub-preview-hub-6')).toBeTruthy()
    expect(screen.getByTestId('theme-packs-hub-download-hub-6')).toBeTruthy()
  })
})
