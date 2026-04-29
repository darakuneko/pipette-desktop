// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'
import { useInlineRename } from '../../hooks/useInlineRename'
import { PANEL_COLLAPSED_WIDTH } from './keymap-editor-types'
import { Tooltip } from '../ui/Tooltip'

const LAYER_NUM_BASE = 'w-8 shrink-0 rounded-md border flex items-center justify-center py-1.5 cursor-pointer text-[12px] font-semibold tabular-nums transition-colors'
const LAYER_NAME_BASE = 'flex-1 min-w-0 rounded-md border px-3 py-1.5 transition-colors'

function layerNumClass(active: boolean): string {
  if (active) return `${LAYER_NUM_BASE} border-accent bg-accent text-content-inverse`
  return `${LAYER_NUM_BASE} border-edge bg-surface/20 text-content-muted hover:bg-surface-dim`
}

function layerNameClass(active: boolean, editable: boolean): string {
  const base = editable ? `${LAYER_NAME_BASE} cursor-pointer` : LAYER_NAME_BASE
  if (active) return `${base} border-accent/50 bg-accent/5`
  return `${base} border-edge bg-surface/20 hover:border-content-muted/30`
}

const LAYER_TOGGLE_BTN = 'flex items-center justify-center rounded-md p-0.5 text-content-muted hover:text-content hover:bg-surface-dim transition-colors'

export interface LayerListPanelProps {
  layers: number
  currentLayer: number
  onLayerChange: (layer: number) => void
  layerNames?: string[]
  onSetLayerName?: (layer: number, name: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

function LayerNumButton({ index, active, onLayerChange }: {
  index: number
  active: boolean
  onLayerChange: (layer: number) => void
}) {
  return (
    <div
      className={layerNumClass(active)}
      data-testid={`layer-panel-layer-num-${index}`}
      onClick={() => onLayerChange(index)}
    >
      {index}
    </div>
  )
}

export function LayerListPanel({ layers, currentLayer, onLayerChange, layerNames, onSetLayerName, collapsed, onToggleCollapse }: LayerListPanelProps) {
  const { t } = useTranslation()
  const layerRename = useInlineRename<number>()

  function commitLayerRename(layerIndex: number): void {
    const trimmed = layerRename.commitRename(layerIndex)
    if (trimmed !== null) {
      const changed = trimmed !== (layerNames?.[layerIndex] ?? '')
      if (changed && onSetLayerName) {
        onSetLayerName(layerIndex, trimmed)
      }
    }
  }

  function handleLayerRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>, layerIndex: number): void {
    if (e.key === 'Enter') {
      commitLayerRename(layerIndex)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      layerRename.cancelRename()
    }
  }

  // Outer container clips content and transitions width.
  // Inner content is always full-width (w-44); collapsing just shrinks the
  // visible area so names slide out horizontally.
  return (
    <div
      className="shrink-0 overflow-hidden rounded-[10px] border border-edge bg-picker-bg transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? PANEL_COLLAPSED_WIDTH : '11rem' }}
      data-testid={collapsed ? 'layer-list-panel-collapsed' : 'layer-list-panel'}
    >
      <div className="flex h-full w-44 flex-col p-2">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-1 pb-1">
            {Array.from({ length: layers }, (_, i) => {
              const name = layerNames?.[i] ?? ''
              const defaultLabel = t('editor.keymap.layerN', { n: i })
              const isActive = i === currentLayer
              const isEditing = !collapsed && layerRename.editingId === i

              return (
                <div
                  key={i}
                  className="flex shrink-0 items-center gap-1.5"
                  data-testid={`layer-panel-layer-${i}`}
                >
                  <LayerNumButton index={i} active={isActive} onLayerChange={onLayerChange} />
                  <div
                    className={`${collapsed ? 'hidden' : layerNameClass(isActive, !!onSetLayerName)}${layerRename.confirmedId === i ? ' confirm-flash' : ''}`}
                    data-testid={`layer-panel-layer-name-box-${i}`}
                    onClick={!collapsed && onSetLayerName ? () => { if (!isEditing) layerRename.startRename(i, name) } : undefined}
                  >
                    {isEditing && onSetLayerName ? (
                      <input
                        data-testid={`layer-panel-layer-name-input-${i}`}
                        className="w-full border-b border-edge bg-transparent text-[12px] text-content outline-none focus:border-accent"
                        value={layerRename.editLabel}
                        onChange={(e) => layerRename.setEditLabel(e.target.value)}
                        placeholder={defaultLabel}
                        autoFocus
                        maxLength={32}
                        onBlur={() => commitLayerRename(i)}
                        onKeyDown={(e) => handleLayerRenameKeyDown(e, i)}
                      />
                    ) : (
                      <span
                        className={`block truncate text-[12px] ${isActive ? 'text-content' : 'text-content-secondary'}`}
                        data-testid={`layer-panel-layer-name-${i}`}
                      >
                        {name || defaultLabel}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="shrink-0">
          <div className="border-t border-edge" style={collapsed ? { maxWidth: '2rem' } : undefined} />
          <div className="flex pt-2">
            <Tooltip content={collapsed ? t('editor.keymap.expandLayers') : t('editor.keymap.collapseLayers')}>
              <button
                type="button"
                className={LAYER_TOGGLE_BTN}
                onClick={onToggleCollapse}
                aria-label={collapsed ? t('editor.keymap.expandLayers') : t('editor.keymap.collapseLayers')}
                data-testid={collapsed ? 'layer-panel-expand-btn' : 'layer-panel-collapse-btn'}
              >
                {collapsed ? <ChevronsRight size={14} aria-hidden="true" /> : <ChevronsLeft size={14} aria-hidden="true" />}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  )
}
