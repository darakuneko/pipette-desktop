// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronUp } from 'lucide-react'
import { AnchoredPopover } from './ui/AnchoredPopover'
import { ICON_XS } from '../constants/ui-tokens'

export interface UpwardSelectOption {
  id: string
  name: string
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
        className="z-50 max-h-60 overflow-y-auto rounded border border-edge bg-surface py-0.5 shadow-lg"
        role="listbox"
        aria-label={ariaLabel}
      >
        {options.map((o) => (
          <div
            key={o.id}
            role="option"
            aria-selected={o.id === value}
            className={`cursor-pointer whitespace-nowrap px-2.5 py-1 text-xs ${
              o.id === value ? 'bg-accent/10 text-accent' : 'text-content hover:bg-surface-hover'
            }`}
            onMouseDown={(e) => {
              e.preventDefault()
              onChange(o.id)
              setOpen(false)
            }}
          >
            {o.name}
          </div>
        ))}
      </AnchoredPopover>
    </>
  )
}
