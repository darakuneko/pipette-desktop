// SPDX-License-Identifier: GPL-2.0-or-later

import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'
import { codeToLabel, findKeycode, type Keycode } from '../../../shared/keycodes/keycodes'
import type { MacroAction } from '../../../preload/macro'

const MAX_VISIBLE_MACRO_ACTIONS = 6
const GRID_COLUMNS = 12
const GRID_GAP_PX = 4 // gap-1
const TILE_BORDER_Y = 2 // border (1px top + 1px bottom)
const TILE_PADDING_TOP = 4 // p-1
const TILE_PADDING_BOTTOM = 4 // p-1
const TILE_CONTENT_MT = 12 // mt-3 on TILE_CONTENT; clears the absolute text-xs leading-none index label
const MACRO_LINE_HEIGHT = 12.375 // text-3xs 9px × leading-snug 1.375

const TILE_ENABLED = 'justify-start border-accent bg-accent/20 text-accent font-semibold hover:bg-accent/30'
const TILE_DISABLED = 'justify-start border-accent/50 bg-accent/10 text-accent/70 font-semibold hover:bg-accent/15'
const TILE_EMPTY = 'justify-center border-accent/30 bg-accent/5 text-content-secondary hover:bg-accent/10'
const TILE_BASE = 'relative flex aspect-square min-h-0 flex-col items-start rounded-md border p-1 pl-1.5 text-3xs leading-snug transition-colors'
const TILE_INDEX_LABEL = 'absolute top-0.5 left-1 text-xs leading-none font-medium text-content-secondary'
const TILE_CONTENT = 'mt-3 inline-grid grid-cols-auto-1fr gap-x-1 overflow-hidden'

function SettingsNote() {
  const { t } = useTranslation()
  return <p className="mt-2 text-xs text-content-muted text-right">{t('keycodes.settingsNote')}</p>
}

interface SettingsTileGridProps<T> {
  entries: T[]
  fields: ReadonlyArray<{ key: keyof T & string; prefix: string }>
  isConfigured: (entry: T) => boolean
  /** Optional enabled check for 3-state tiles (enabled / disabled / empty) */
  isEnabled?: (entry: T) => boolean
  onOpen: (index: number) => void
  testIdPrefix: string
}

function tileStyle(configured: boolean, enabled?: boolean): string {
  if (!configured) return TILE_EMPTY
  if (enabled === false) return TILE_DISABLED
  return TILE_ENABLED
}

function SettingsTileGrid<T>({ entries, fields, isConfigured, isEnabled, onOpen, testIdPrefix }: SettingsTileGridProps<T>) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="grid grid-cols-12 auto-rows-fr gap-1">
        {entries.map((entry, i) => {
          const configured = isConfigured(entry)
          const enabled = configured && isEnabled ? isEnabled(entry) : undefined
          return (
            <button
              key={i}
              type="button"
              data-testid={`${testIdPrefix}-tile-${i}`}
              data-configured={configured || undefined}
              className={`${TILE_BASE} ${tileStyle(configured, enabled)}`}
              onClick={() => onOpen(i)}
            >
              <span className={TILE_INDEX_LABEL}>{i}</span>
              {configured ? (
                <span className={`${TILE_CONTENT} gap-y-0`}>
                  {fields.map(({ key, prefix }) => (
                    <Fragment key={key}>
                      <span className="text-left text-content-secondary/60">{prefix}</span>
                      <span className="truncate text-left">{(entry[key] as number) !== 0 ? codeToLabel(entry[key] as number) : ''}</span>
                    </Fragment>
                  ))}
                </span>
              ) : (
                <span className="w-full text-center text-content-secondary/60">
                  {t('common.notConfigured')}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <SettingsNote />
    </div>
  )
}

const COMBO_FIELDS = [
  { key: 'key1' as const, prefix: 'K1' },
  { key: 'key2' as const, prefix: 'K2' },
  { key: 'key3' as const, prefix: 'K3' },
  { key: 'key4' as const, prefix: 'K4' },
  { key: 'output' as const, prefix: 'O' },
]

const KEY_OVERRIDE_FIELDS = [
  { key: 'triggerKey' as const, prefix: 'T' },
  { key: 'replacementKey' as const, prefix: 'R' },
]

const ALT_REPEAT_KEY_FIELDS = [
  { key: 'lastKey' as const, prefix: 'L' },
  { key: 'altKey' as const, prefix: 'A' },
]

const TD_FIELDS = [
  { key: 'onTap', prefix: 'T' },
  { key: 'onHold', prefix: 'H' },
  { key: 'onDoubleTap', prefix: 'DT' },
  { key: 'onTapHold', prefix: 'TH' },
] as const

const MACRO_PREFIX: Record<MacroAction['type'], string> = {
  tap: 'T',
  down: 'D',
  up: 'U',
  text: 'Tx',
  delay: 'W',
}

function macroActionLabel(action: MacroAction): string {
  switch (action.type) {
    case 'text': return action.text
    case 'delay': return `${action.delay}ms`
    default: return action.keycodes.map(codeToLabel).join(' ')
  }
}

interface TdTileGridProps {
  entries: TapDanceEntry[]
  onSelect: (keycode: Keycode) => void
  /** Double-click / Enter commit. When omitted, only onSelect runs on click. */
  onDoubleClick?: (keycode: Keycode) => void
}

export function TdTileGrid({ entries, onSelect, onDoubleClick }: TdTileGridProps) {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-12 auto-rows-fr gap-1">
      {entries.map((entry, i) => {
        const configured = entry.onTap !== 0 || entry.onHold !== 0 || entry.onDoubleTap !== 0 || entry.onTapHold !== 0
        const kc = findKeycode(`TD(${i})`)
        const select = kc ? () => onSelect(kc) : undefined
        const commit = kc && onDoubleClick ? () => onDoubleClick(kc) : undefined
        return (
          <button
            key={i}
            type="button"
            data-testid={`td-tile-${i}`}
            data-configured={configured || undefined}
            className={`${TILE_BASE} ${configured ? TILE_ENABLED : TILE_EMPTY}`}
            onClick={select}
            onDoubleClick={commit}
          >
            <span className={TILE_INDEX_LABEL}>TD({i})</span>
            {configured ? (
              <span className={`${TILE_CONTENT} gap-y-px`}>
                {TD_FIELDS.map(({ key, prefix }) => (
                  <Fragment key={key}>
                    <span className="text-left text-content-secondary/60">{prefix}</span>
                    <span className="truncate text-left">{entry[key] !== 0 ? codeToLabel(entry[key]) : ''}</span>
                  </Fragment>
                ))}
              </span>
            ) : (
              <span className="w-full text-center text-content-secondary/60">
                {t('common.notConfigured')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

interface MacroTileGridProps {
  macros: MacroAction[][]
  onSelect: (keycode: Keycode) => void
  /** Double-click / Enter commit. When omitted, only onSelect runs on click. */
  onDoubleClick?: (keycode: Keycode) => void
}

function useMacroFitLines(gridRef: React.RefObject<HTMLDivElement | null>): number {
  const [fitLines, setFitLines] = useState(MAX_VISIBLE_MACRO_ACTIONS)

  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const gridWidth = entry.contentRect.width
        const tileWidth = (gridWidth - GRID_GAP_PX * (GRID_COLUMNS - 1)) / GRID_COLUMNS
        const tileHeight = tileWidth
        const contentHeight = tileHeight - TILE_BORDER_Y - TILE_PADDING_TOP - TILE_CONTENT_MT - TILE_PADDING_BOTTOM
        const next = Math.min(MAX_VISIBLE_MACRO_ACTIONS, Math.max(1, Math.floor(contentHeight / MACRO_LINE_HEIGHT)))
        setFitLines((prev) => prev !== next ? next : prev)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [gridRef])

  return fitLines
}

export function MacroTileGrid({ macros, onSelect, onDoubleClick }: MacroTileGridProps) {
  const { t } = useTranslation()
  const gridRef = useRef<HTMLDivElement>(null)
  const fitLines = useMacroFitLines(gridRef)
  return (
    <div ref={gridRef} className="grid grid-cols-12 auto-rows-fr gap-1">
      {macros.map((actions, i) => {
        const configured = actions.length > 0
        const visible = actions.length <= fitLines ? actions : actions.slice(0, fitLines - 1)
        const hidden = actions.length - visible.length
        const kc = findKeycode(`M${i}`)
        const select = kc ? () => onSelect(kc) : undefined
        const commit = kc && onDoubleClick ? () => onDoubleClick(kc) : undefined
        return (
          <button
            key={i}
            type="button"
            data-testid={`macro-tile-${i}`}
            data-configured={configured || undefined}
            className={`${TILE_BASE} ${configured ? TILE_ENABLED : TILE_EMPTY}`}
            onClick={select}
            onDoubleClick={commit}
          >
            <span className={TILE_INDEX_LABEL}>M{i}</span>
            {configured ? (
              <span className={`${TILE_CONTENT} gap-y-0`}>
                {visible.map((action, j) => (
                  <Fragment key={j}>
                    <span className="text-left text-content-secondary/60">{MACRO_PREFIX[action.type]}</span>
                    <span className="truncate text-left">{macroActionLabel(action)}</span>
                  </Fragment>
                ))}
                {hidden > 0 && (
                  <span className="col-span-2 truncate text-center text-content-secondary/60">{t('keycodes.macroMoreActions', { count: hidden })}</span>
                )}
              </span>
            ) : (
              <span className="w-full text-center text-content-secondary/60">
                {t('common.notConfigured')}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function ComboTileGrid({ entries, onOpenCombo }: { entries: ComboEntry[]; onOpenCombo: (index: number) => void }) {
  return <SettingsTileGrid entries={entries} fields={COMBO_FIELDS} isConfigured={(e) => e.key1 !== 0 || e.key2 !== 0} onOpen={onOpenCombo} testIdPrefix="combo" />
}

export function KeyOverrideTileGrid({ entries, onOpen }: { entries: KeyOverrideEntry[]; onOpen: (index: number) => void }) {
  return <SettingsTileGrid entries={entries} fields={KEY_OVERRIDE_FIELDS} isConfigured={(e) => e.enabled || e.triggerKey !== 0 || e.replacementKey !== 0} isEnabled={(e) => e.enabled} onOpen={onOpen} testIdPrefix="ko" />
}

export function AltRepeatKeyTileGrid({ entries, onOpen }: { entries: AltRepeatKeyEntry[]; onOpen: (index: number) => void }) {
  return <SettingsTileGrid entries={entries} fields={ALT_REPEAT_KEY_FIELDS} isConfigured={(e) => e.enabled || e.lastKey !== 0 || e.altKey !== 0} isEnabled={(e) => e.enabled} onOpen={onOpen} testIdPrefix="arep" />
}
