// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronUp } from 'lucide-react'
import { AnchoredPopover } from './ui/AnchoredPopover'
import { ICON_XS, PACK_TYPE_TAG_WRITABLE, PACK_TYPE_TAG_VIEW } from '../constants/ui-tokens'

export interface UpwardSelectOption {
  id: string
  name: string
  /**
   * Optional short trailing tag rendered right-aligned next to the name
   * (e.g. "Write" / "View" for Key Label packs — see
   * `useKeyLabelLookup.isKeymapWritable`). Absent for options that carry
   * no such metadata; the row then renders exactly as it did before this
   * field existed (name only).
   *
   * Colors come from `PACK_TYPE_TAG_WRITABLE`/`PACK_TYPE_TAG_VIEW`
   * (ui-tokens.ts), shared with the Key Labels modal's row type label.
   */
  tag?: { label: string; variant: 'accent' | 'secondary' }
}

interface Props {
  value: string
  onChange: (value: string) => void
  options: UpwardSelectOption[]
  'aria-label': string
}

export function UpwardSelect({ value, onChange, options, 'aria-label': ariaLabel }: Props) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const handleClose = useCallback(() => setOpen(false), [])

  const currentName = useMemo(() => options.find((o) => o.id === value)?.name ?? value, [options, value])

  // A tagged list caps its width so long names truncate instead of
  // pushing the tag column out of alignment (see UpwardSelect.test.tsx
  // and the Keyboard Layout select in QuickSettingsSelects.tsx). Left
  // untouched for every other call site (language/theme/basic-view
  // selects) so their existing grow-to-fit sizing is unaffected.
  const hasTags = useMemo(() => options.some((o) => o.tag != null), [options])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-xs text-content-secondary transition-colors hover:text-content focus:border-accent focus:outline-none"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{currentName}</span>
        <ChevronUp size={ICON_XS} className={open ? 'opacity-100' : 'opacity-50'} />
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={handleClose}
        placement="top"
        align="right"
        matchAnchorWidth
        className={`z-50 max-h-60 overflow-y-auto rounded border border-edge bg-surface py-0.5 shadow-lg ${hasTags ? 'max-w-64' : ''}`}
        role="listbox"
        aria-label={ariaLabel}
      >
        {options.map((o) => (
          <div
            key={o.id}
            role="option"
            aria-selected={o.id === value}
            className={`flex cursor-pointer items-center gap-2 px-2.5 py-1 text-xs ${
              o.id === value ? 'bg-accent/10 text-accent' : 'text-content hover:bg-surface-hover'
            }`}
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(o.id)
              setOpen(false)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{o.name}</span>
            {o.tag && (
              <span
                className={`shrink-0 whitespace-nowrap text-right ${
                  o.tag.variant === 'accent' ? PACK_TYPE_TAG_WRITABLE : PACK_TYPE_TAG_VIEW
                }`}
              >
                {o.tag.label}
              </span>
            )}
          </div>
        ))}
      </AnchoredPopover>
    </>
  )
}
