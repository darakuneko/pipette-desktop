// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NotificationModal } from '../NotificationModal'
import type { AppNotification } from '../../../shared/types/notification'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const sampleNotifications: AppNotification[] = [
  { title: 'Update Available', body: 'Version 2.0 is out', type: 'Info', publishedAt: '2025-01-02T00:00:00Z' },
  { title: 'Maintenance', body: 'Server maintenance\nscheduled for tonight', type: 'Warning', publishedAt: '2025-01-01T00:00:00Z' },
]

describe('NotificationModal', () => {
  it('renders all notification items', () => {
    render(<NotificationModal notifications={sampleNotifications} onClose={vi.fn()} />)

    expect(screen.getByText('Update Available')).toBeInTheDocument()
    expect(screen.getByText('Maintenance')).toBeInTheDocument()
  })

  it('displays title, body, and type for each notification', () => {
    render(<NotificationModal notifications={sampleNotifications} onClose={vi.fn()} />)

    expect(screen.getByText('Update Available')).toBeInTheDocument()
    expect(screen.getByText('Version 2.0 is out')).toBeInTheDocument()
    expect(screen.getByText('Info')).toBeInTheDocument()

    expect(screen.getByText('Maintenance')).toBeInTheDocument()
    expect(screen.getByText(/Server maintenance/)).toBeInTheDocument()
    expect(screen.getByText('Warning')).toBeInTheDocument()
  })

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn()
    render(<NotificationModal notifications={sampleNotifications} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('notification-modal-close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when Escape key is pressed', () => {
    const onClose = vi.fn()
    render(<NotificationModal notifications={sampleNotifications} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn()
    render(<NotificationModal notifications={sampleNotifications} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('notification-modal-backdrop'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not call onClose when modal content is clicked', () => {
    const onClose = vi.fn()
    render(<NotificationModal notifications={sampleNotifications} onClose={onClose} />)

    fireEvent.click(screen.getByText('Update Available'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders the notification title from i18n', () => {
    render(<NotificationModal notifications={sampleNotifications} onClose={vi.fn()} />)

    expect(screen.getByText('notification.title')).toBeInTheDocument()
  })
})
