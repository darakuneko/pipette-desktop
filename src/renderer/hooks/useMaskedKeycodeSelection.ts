// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import type { Keycode } from '../../shared/keycodes/keycodes'
import { deserialize, resolve, serialize, isMask, isLMKeycode } from '../../shared/keycodes/keycodes'

interface Options {
  onUpdate: (code: number) => boolean | void  // Update the field; return false to skip
  onCommit: () => void              // Close the picker / deselect the field
  resetKey?: unknown
  initialValue?: number             // Current field value — auto-detect mask on mount
}

interface Result {
  handleKeycodeSelect: (kc: Keycode) => void
  maskOnly: boolean
  lmMode: boolean
  activeMask: number | null
  editingPart: 'outer' | 'inner' | null
  clearMask: () => void
  confirm: () => void
  setEditingPart: (part: 'outer' | 'inner') => void
  enterMaskMode: (code: number, part: 'outer' | 'inner') => void
}

export function useMaskedKeycodeSelection({ onUpdate, onCommit, resetKey, initialValue }: Options): Result {
  const [activeMask, setActiveMask] = useState<number | null>(null)
  const [editingPart, setEditingPart] = useState<'outer' | 'inner' | null>(null)
  const activeMaskRef = useRef(activeMask)
  activeMaskRef.current = activeMask
  const editingPartRef = useRef(editingPart)
  editingPartRef.current = editingPart
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const initialValueRef = useRef(initialValue)
  initialValueRef.current = initialValue
  const manualMaskRef = useRef(false)

  function resetState(): void {
    setActiveMask(null)
    setEditingPart(null)
  }

  useEffect(() => {
    if (manualMaskRef.current) {
      manualMaskRef.current = false
      return
    }
    const val = initialValueRef.current
    if (val != null && val !== 0 && isMask(serialize(val))) {
      setActiveMask(val)
      setEditingPart('inner')
      return
    }
    resetState()
  }, [resetKey])

  const clearMask = useCallback(() => {
    resetState()
  }, [])

  const confirm = useCallback(() => {
    onCommitRef.current()
    resetState()
  }, [])

  const enterMaskMode = useCallback((code: number, part: 'outer' | 'inner') => {
    manualMaskRef.current = true
    setActiveMask(code)
    setEditingPart(part)
  }, [])

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      const mask = activeMaskRef.current
      const part = editingPartRef.current

      // Mask active + editing inner: resolve inner key, update but don't commit
      if (mask !== null && part === 'inner') {
        const innerCode = deserialize(kc.qmkId)
        const final = isLMKeycode(mask)
          ? (mask & ~resolve('QMK_LM_MASK')) | (innerCode & resolve('QMK_LM_MASK'))
          : (mask & 0xff00) | (innerCode & 0x00ff)
        if (onUpdateRef.current(final) !== false) {
          setActiveMask(final)
        }
        return
      }

      // Masked keycode selected: enter or replace mask mode
      if (kc.masked) {
        const maskCode = deserialize(kc.qmkId)
        if (onUpdateRef.current(maskCode) !== false) {
          setActiveMask(maskCode)
          setEditingPart('inner')
        }
        return
      }

      // Normal key: update value, clear mask state but don't auto-commit
      if (onUpdateRef.current(deserialize(kc.qmkId)) !== false) {
        resetState()
      }
    },
    [],
  )

  const maskOnly = editingPart === 'inner' && activeMask !== null && !isLMKeycode(activeMask)
  const lmMode = editingPart === 'inner' && activeMask !== null && isLMKeycode(activeMask)

  return { handleKeycodeSelect, maskOnly, lmMode, activeMask, editingPart, clearMask, confirm, setEditingPart, enterMaskMode }
}
