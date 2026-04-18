// SPDX-License-Identifier: GPL-2.0-or-later

import { Fragment, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TapDanceEntry, ComboEntry, KeyOverrideEntry, AltRepeatKeyEntry } from '../../../shared/types/protocol'
import { codeToLabel, findKeycode, type Keycode } from '../../../shared/keycodes/keycodes'
import type { MacroAction } from '../../../preload/macro'

const MIN_VISIBLE_MACRO_ACTIONS = 6
const GRID_COLUMNS = 12
const GRID_GAP_PX = 4
const TILE_PADDING_TOP = 4
const TILE_LABEL_HEIGHT = 12
const TILE_CONTENT_MT = 8
const MACRO_LINE_HEIGHT = 12
const MACRO_MORE_ROW_HEIGHT = 12

const TILE_ENABLED = 'justify-start border-accent bg-accent/20 text-accent font-semibold hover:bg-accent/30'
const TILE_DISABLED = 'justify-start border-accent/50 bg-accent/10 text-accent/70 font-semibold hover:bg-accent/15'
const TILE_EMPTY = 'justify-center border-accent/30 bg-accent/5 text-content-secondary hover:bg-accent/10'

function SettingsNote() {
  const { t } = useTranslation()
  return <p className="mt-2 text-xs text-content-muted text-right">{t('keycodes.settingsNote')}</p>
}

interface SettingsTileGridProps<T extends Record<string, unknown>> {
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

function SettingsTileGrid<T extends Record<string, unknown>>({ entries, fields, isConfigured, isEnabled, onOpen, testIdPrefix }: SettingsTileGridProps<T>) {
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
              className={`relative flex aspect-square min-h-0 flex-col items-start rounded-md border p-1 pl-1.5 text-[9px] leading-snug transition-colors ${tileStyle(configured, enabled)}`}
              onClick={() => onOpen(i)}
            >
              <span className="absolute top-0.5 left-1 text-[8px] text-content-secondary/60">{i}</span>
              {configured ? (
                <span className="mt-2 inline-grid grid-cols-[auto_1fr] gap-x-1 gap-y-px overflow-hidden">
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
            className={`relative flex aspect-square min-h-0 flex-col items-start rounded-md border p-1 pl-1.5 text-[9px] leading-snug transition-colors ${configured ? TILE_ENABLED : TILE_EMPTY}`}
            onClick={select}
            onDoubleClick={commit}
          >
            <span className="absolute top-0.5 left-1 text-[8px] text-content-secondary/60">TD({i})</span>
            {configured ? (
              <span className="mt-2 inline-grid grid-cols-[auto_1fr] gap-x-1 gap-y-px">
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

function useMacroVisibleLines(gridRef: React.RefObject<HTMLDivElement | null>): number {
  const [visibleLines, setVisibleLines] = useState(MIN_VISIBLE_MACRO_ACTIONS)

  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const gridWidth = entry.contentRect.width
        const tileWidth = (gridWidth - GRID_GAP_PX * (GRID_COLUMNS - 1)) / GRID_COLUMNS
        const tileHeight = tileWidth
        const contentHeight = tileHeight - TILE_PADDING_TOP - TILE_LABEL_HEIGHT - TILE_CONTENT_MT
        const actionLines = Math.floor((contentHeight - MACRO_MORE_ROW_HEIGHT) / MACRO_LINE_HEIGHT)
        const next = Math.max(MIN_VISIBLE_MACRO_ACTIONS, actionLines)
        setVisibleLines((prev) => prev !== next ? next : prev)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [gridRef])

  return visibleLines
}

export function MacroTileGrid({ macros, onSelect, onDoubleClick }: MacroTileGridProps) {
  const { t } = useTranslation()
  const gridRef = useRef<HTMLDivElement>(null)
  const maxVisible = useMacroVisibleLines(gridRef)
  return (
    <div ref={gridRef} className="grid grid-cols-12 auto-rows-fr gap-1">
      {macros.map((actions, i) => {
        const configured = actions.length > 0
        const kc = findKeycode(`M${i}`)
        const select = kc ? () => onSelect(kc) : undefined
        const commit = kc && onDoubleClick ? () => onDoubleClick(kc) : undefined
        return (
          <button
            key={i}
            type="button"
            data-testid={`macro-tile-${i}`}
            data-configured={configured || undefined}
            className={`relative flex aspect-square min-h-0 flex-col items-start rounded-md border p-1 pl-1.5 text-[9px] leading-snug transition-colors ${configured ? TILE_ENABLED : TILE_EMPTY}`}
            onClick={select}
            onDoubleClick={commit}
          >
            <span className="absolute top-0.5 left-1 text-[8px] text-content-secondary/60">M{i}</span>
            {configured ? (
              <span className="mt-2 inline-grid grid-cols-[auto_1fr] gap-x-1 gap-y-0 overflow-hidden">
                {actions.slice(0, maxVisible).map((action, j) => (
                  <Fragment key={j}>
                    <span className="text-left text-content-secondary/60">{MACRO_PREFIX[action.type]}</span>
                    <span className="truncate text-left">{macroActionLabel(action)}</span>
                  </Fragment>
                ))}
                {actions.length > maxVisible && (
                  <span className="col-span-2 text-center text-content-secondary/60">{t('keycodes.macroMoreActions', { count: actions.length - maxVisible })}</span>
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
