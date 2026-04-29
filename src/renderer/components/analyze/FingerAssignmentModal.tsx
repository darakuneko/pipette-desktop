// SPDX-License-Identifier: GPL-2.0-or-later
// Finger Assignment modal — lets the user override the geometry-based
// finger estimate per physical key. The modal is scoped to the
// currently selected Analyze keyboard and saves to
// PipetteSettings.analyze.fingerAssignments via the parent view.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { KleKey, KeyboardLayout } from '../../../shared/kle/types'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import {
  buildErgonomicsContext,
  estimateErgonomicsWithContext,
} from '../../../shared/kle/kle-ergonomics'
import { posKey } from '../../../shared/kle/pos-key'
import { KeyboardWidget } from '../keyboard/KeyboardWidget'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { FingerSelectPopover } from './FingerSelectPopover'
import { fingerColor } from './finger-colors'

interface Props {
  isOpen: boolean
  onClose: () => void
  snapshot: TypingKeymapSnapshot | null
  assignments: Record<string, FingerType>
  onSave: (next: Record<string, FingerType>) => void
}

type HoverPos = { key: KleKey; rect: DOMRect }

export function FingerAssignmentModal({
  isOpen,
  onClose,
  snapshot,
  assignments,
  onSave,
}: Props) {
  const { t } = useTranslation()
  const theme = useEffectiveTheme()
  const [selected, setSelected] = useState<{ key: KleKey; anchorRect: DOMRect } | null>(null)
  // Hover rect is captured by KeyboardWidget's onKeyHover (the only
  // click-local DOMRect source it exposes) and reused on click.
  const [hoverPos, setHoverPos] = useState<HoverPos | null>(null)
  // Local draft so edits can be cancelled via X / Esc / backdrop click.
  // Only the Save button commits the draft back to the parent.
  const [draft, setDraft] = useState<Record<string, FingerType>>(assignments)

  useEffect(() => {
    if (isOpen) {
      setDraft({ ...assignments })
    } else {
      setSelected(null)
      setHoverPos(null)
    }
  }, [isOpen, assignments])

  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (selected) setSelected(null)
      else onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose, selected])

  const layout = (snapshot?.layout ?? null) as KeyboardLayout | null
  const keys = layout?.keys ?? []
  const ctx = useMemo(() => buildErgonomicsContext(keys), [keys])

  const resolveFinger = useCallback(
    (key: KleKey): FingerType | undefined => {
      const pos = posKey(key.row, key.col)
      const override = draft[pos]
      if (override) return override
      if (!ctx) return undefined
      return estimateErgonomicsWithContext(key, ctx).finger
    },
    [draft, ctx],
  )

  const labelOverrides = useMemo(() => {
    const m = new Map<string, { outer: string; inner: string; masked: boolean }>()
    for (const k of keys) {
      const finger = resolveFinger(k)
      if (!finger) continue
      const pos = posKey(k.row, k.col)
      const short = t(`analyze.finger.short.${finger}`)
      const isOverride = pos in draft
      // Prefix "*" marks manually overridden keys so the user can tell
      // them apart from keys that still follow the geometry estimate.
      m.set(pos, {
        outer: isOverride ? `*${short}` : short,
        inner: '',
        masked: false,
      })
    }
    return m
  }, [keys, resolveFinger, t, draft])

  const keyColors = useMemo(() => {
    const m = new Map<string, string>()
    for (const k of keys) {
      const finger = resolveFinger(k)
      if (!finger) continue
      m.set(posKey(k.row, k.col), fingerColor(finger, theme))
    }
    return m
  }, [keys, resolveFinger, theme])

  const emptyKeycodes = useMemo(() => new Map<string, string>(), [])

  const handleKeyHover = useCallback(
    (key: KleKey, _keycode: string, rect: DOMRect) => {
      setHoverPos({ key, rect })
    },
    [],
  )

  // Hover state intentionally persists after the pointer leaves the svg so a
  // click fired right after the pointer-out event still has a rect to anchor
  // the popover against; no onKeyHoverEnd handler is needed.

  const handleKeyClick = useCallback(
    (key: KleKey) => {
      const anchor = hoverPos && hoverPos.key.row === key.row && hoverPos.key.col === key.col
        ? hoverPos.rect
        : null
      if (!anchor) return
      setSelected({ key, anchorRect: anchor })
    },
    [hoverPos],
  )

  const handleSelectFinger = useCallback(
    (finger: FingerType) => {
      if (!selected) return
      const pos = posKey(selected.key.row, selected.key.col)
      setDraft((prev) => ({ ...prev, [pos]: finger }))
      setSelected(null)
    },
    [selected],
  )

  const handleReset = useCallback(() => {
    if (!selected) return
    const pos = posKey(selected.key.row, selected.key.col)
    setDraft((prev) => {
      if (!(pos in prev)) return prev
      const { [pos]: _removed, ...rest } = prev
      return rest
    })
    setSelected(null)
  }, [selected])

  const handleResetAll = useCallback(() => {
    setDraft((prev) => (Object.keys(prev).length === 0 ? prev : {}))
  }, [])

  const handleSave = useCallback(() => {
    onSave(draft)
    onClose()
  }, [draft, onSave, onClose])

  if (!isOpen) return null

  const selectedPosKey = selected ? posKey(selected.key.row, selected.key.col) : null
  const selectedOverride = selectedPosKey ? draft[selectedPosKey] : undefined
  const selectedFinger = selected ? resolveFinger(selected.key) : undefined

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="finger-assignment-modal"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="finger-assignment-title"
        className="w-[960px] max-w-[95vw] max-h-[90vh] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-0 shrink-0">
          <h2 id="finger-assignment-title" className="text-lg font-bold text-content">
            {t('analyze.fingerAssignment.title')}
          </h2>
          <ModalCloseButton testid="finger-assignment-close" onClick={onClose} />
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-5 py-4">
          <p className="mb-3 text-[12px] text-content-muted">
            {t('analyze.fingerAssignment.subtitle')}
          </p>
          {keys.length === 0 ? (
            <div className="py-4 text-center text-[13px] text-content-muted" data-testid="finger-assignment-empty">
              {t('analyze.fingerAssignment.noSnapshot')}
            </div>
          ) : (
            <div className="flex justify-center">
              <KeyboardWidget
                keys={keys}
                keycodes={emptyKeycodes}
                labelOverrides={labelOverrides}
                keyColors={keyColors}
                onKeyClick={handleKeyClick}
                onKeyHover={handleKeyHover}
                scale={1}
              />
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-edge px-5 py-3 shrink-0">
          <button
            type="button"
            className="rounded-md border border-edge px-3 py-1.5 text-[13px] text-content-muted hover:border-accent hover:text-content disabled:opacity-50 disabled:hover:border-edge disabled:hover:text-content-muted"
            onClick={handleResetAll}
            disabled={Object.keys(draft).length === 0}
            data-testid="finger-assignment-reset-all"
          >
            {t('analyze.fingerAssignment.resetAll')}
          </button>
          <button
            type="button"
            className="rounded-md border border-accent bg-accent px-4 py-1.5 text-[13px] font-medium text-surface hover:bg-accent/90"
            onClick={handleSave}
            data-testid="finger-assignment-save"
          >
            {t('analyze.fingerAssignment.save')}
          </button>
        </div>
      </div>
      {selected && (
        <FingerSelectPopover
          anchorRect={selected.anchorRect}
          currentFinger={selectedFinger}
          isOverride={selectedOverride !== undefined}
          onSelect={handleSelectFinger}
          onReset={handleReset}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
