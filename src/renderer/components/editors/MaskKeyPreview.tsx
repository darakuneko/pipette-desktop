// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { serialize } from '../../../shared/keycodes/keycodes'
import { KeyWidget } from '../keyboard/KeyWidget'
import type { KleKey } from '../../../shared/kle/types'
import { KEY_UNIT } from '../keyboard/constants'

const PREVIEW_KEY: KleKey = {
  x: 0,
  y: 0,
  width: 1.5,
  height: 1,
  x2: 0,
  y2: 0,
  width2: 1.5,
  height2: 1,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  color: '',
  labels: Array(12).fill(null) as (string | null)[],
  textColor: Array(12).fill(null) as (string | null)[],
  textSize: Array(12).fill(null) as (number | null)[],
  row: 0,
  col: 0,
  encoderIdx: -1,
  encoderDir: -1,
  layoutIndex: -1,
  layoutOption: -1,
  decal: false,
  nub: false,
  stepped: false,
  ghost: false,
}

const SVG_WIDTH = KEY_UNIT * 1.5
const SVG_HEIGHT = KEY_UNIT

interface ConfirmProps {
  onConfirm: () => void
  keycode?: undefined
  lmMode?: undefined
}

interface PreviewProps {
  keycode: number
  lmMode: boolean
  onConfirm?: undefined
}

type Props = ConfirmProps | PreviewProps

/** Select button with Enter key handler, or visual masked keycode preview. */
export function MaskKeyPreview(props: Props) {
  const { t } = useTranslation()

  // Confirm button mode
  if (props.onConfirm !== undefined) {
    const { onConfirm } = props

    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
        e.preventDefault()
        onConfirm()
      }
      window.addEventListener('keydown', handler)
      return () => window.removeEventListener('keydown', handler)
    }, [onConfirm])

    return (
      <button
        type="button"
        data-testid="mask-confirm-btn"
        className="rounded bg-accent px-2 py-0.5 text-xs text-content-inverse hover:bg-accent-hover"
        onClick={onConfirm}
      >
        {t('common.select')}
      </button>
    )
  }

  // Visual preview mode
  const { keycode, lmMode } = props
  const qmkId = serialize(keycode)

  return (
    <div className="flex items-center gap-3 py-1">
      <svg
        width={SVG_WIDTH}
        height={SVG_HEIGHT}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="shrink-0"
      >
        <KeyWidget
          kleKey={PREVIEW_KEY}
          keycode={qmkId}
          selected
          selectedMaskPart
        />
      </svg>
      <span className="text-sm text-content-secondary">
        {lmMode ? t('editor.mask.selectModifier') : t('editor.mask.selectInnerKey')}
      </span>
    </div>
  )
}
