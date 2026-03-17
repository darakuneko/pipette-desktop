// SPDX-License-Identifier: GPL-2.0-or-later

import { useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import { serialize, deserialize } from '../../../shared/keycodes/keycodes'
import { JsonEditorModal } from './JsonEditorModal'

type TapDanceArray = [string, string, string, string, number]

function entriesToJson(entries: TapDanceEntry[]): string {
  const arr: TapDanceArray[] = entries.map((e) => [
    serialize(e.onTap),
    serialize(e.onHold),
    serialize(e.onDoubleTap),
    serialize(e.onTapHold),
    e.tappingTerm,
  ])
  return JSON.stringify(arr, null, 2)
}

function isValidKeycode(kc: string): boolean {
  const code = deserialize(kc)
  return serialize(code) === kc || code !== 0 || kc === 'KC_NO'
}

function parseJson(
  json: string,
  expectedLength: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { error: string | null; value?: TapDanceEntry[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: t('editor.tapDance.invalidJson') }
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    return { error: t('editor.tapDance.invalidJson') }
  }
  const entries: TapDanceEntry[] = []
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx]
    if (!Array.isArray(item) || item.length !== 5) {
      return { error: t('editor.tapDance.invalidJson') }
    }
    const [onTap, onHold, onDoubleTap, onTapHold, tappingTerm] = item as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ]
    if (typeof tappingTerm !== 'number' || tappingTerm < 0 || tappingTerm > 10000) {
      return { error: t('editor.tapDance.invalidTappingTerm') }
    }
    const keycodes = [onTap, onHold, onDoubleTap, onTapHold]
    for (const kc of keycodes) {
      if (typeof kc !== 'string') return { error: t('editor.tapDance.invalidJson') }
      if (!isValidKeycode(kc)) {
        return { error: t('editor.tapDance.unknownKeycode', { keycode: kc }) }
      }
    }
    entries.push({
      onTap: deserialize(onTap as string),
      onHold: deserialize(onHold as string),
      onDoubleTap: deserialize(onDoubleTap as string),
      onTapHold: deserialize(onTapHold as string),
      tappingTerm: tappingTerm as number,
    })
  }
  return { error: null, value: entries }
}

interface Props {
  entries: TapDanceEntry[]
  onApply: (entries: TapDanceEntry[]) => void | Promise<void>
  onClose: () => void
}

export function TapDanceJsonEditor({ entries, onApply, onClose }: Props) {
  const { t } = useTranslation()
  const initialJson = useMemo(() => entriesToJson(entries), [entries])

  const parse = useCallback(
    (text: string) => parseJson(text, entries.length, t),
    [entries.length, t],
  )

  return (
    <JsonEditorModal<TapDanceEntry[]>
      title={t('editor.tapDance.jsonEditorTitle')}
      initialText={initialJson}
      parse={parse}
      onApply={onApply}
      onClose={onClose}
      testIdPrefix="tap-dance-json-editor"
      exportFileName="td"
    />
  )
}
