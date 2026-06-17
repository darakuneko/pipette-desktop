// SPDX-License-Identifier: GPL-2.0-or-later
//
// Promise-based access to the pre-upload confirmation dialog. Any Hub
// upload handler can `await requestUploadOptions(...)` to let the user
// pick Public / Private (and an expiry) before the network call. The
// promise resolves with the choice, or `null` if the user cancels.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  UploadConfirmModal,
  type UploadChoice,
  type UploadConfirmRequest,
} from '../components/hub/UploadConfirmModal'

interface UploadConfirmContextValue {
  requestUploadOptions: (request: UploadConfirmRequest) => Promise<UploadChoice | null>
  /** True while the confirmation dialog is on screen. Host panels read
   *  this to suppress their own close-on-backdrop / close-on-Escape so a
   *  click or Escape aimed at the dialog does not also dismiss them. */
  isOpen: boolean
}

// Fallback used when no provider is mounted (e.g. an isolated component
// test that renders a Hub row without the app root). It resolves to a
// public upload — the pre-feature behaviour — so the dialog being absent
// degrades safely rather than throwing. The real app always wraps the
// tree in <UploadConfirmProvider> (see index.tsx), so the modal shows in
// production.
const FALLBACK_VALUE: UploadConfirmContextValue = {
  requestUploadOptions: () => Promise.resolve({ visibility: 'public', expiresInDays: null }),
  isOpen: false,
}

const UploadConfirmContext = createContext<UploadConfirmContextValue>(FALLBACK_VALUE)

export function UploadConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<UploadConfirmRequest | null>(null)
  const resolverRef = useRef<((choice: UploadChoice | null) => void) | null>(null)

  const requestUploadOptions = useCallback((request: UploadConfirmRequest): Promise<UploadChoice | null> => {
    return new Promise<UploadChoice | null>((resolve) => {
      resolverRef.current = resolve
      setPending(request)
    })
  }, [])

  const settle = useCallback((choice: UploadChoice | null) => {
    setPending(null)
    const resolve = resolverRef.current
    resolverRef.current = null
    resolve?.(choice)
  }, [])

  const value = useMemo(() => ({ requestUploadOptions, isOpen: pending !== null }), [requestUploadOptions, pending])

  return (
    <UploadConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <UploadConfirmModal
          request={pending}
          onConfirm={(choice) => settle(choice)}
          onCancel={() => settle(null)}
        />
      )}
    </UploadConfirmContext.Provider>
  )
}

export function useUploadConfirm(): UploadConfirmContextValue {
  return useContext(UploadConfirmContext)
}
