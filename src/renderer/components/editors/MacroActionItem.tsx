// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { GripVertical } from 'lucide-react'
import { isValidMacroText, type MacroAction } from '../../../preload/macro'
import { KeycodeField, KEYCODE_FIELD_SIZE } from './KeycodeField'

export type ActionType = MacroAction['type']

interface Props {
  action: MacroAction
  index: number
  onChange: (index: number, action: MacroAction) => void
  onDelete: (index: number) => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  onDragEnd: () => void
  dropIndicator: 'above' | 'below' | null
  selectedKeycodeIndex: number | null
  selectedMaskPart?: boolean
  onKeycodeClick: (keycodeIndex: number) => void
  onKeycodeDoubleClick: (keycodeIndex: number, rect: DOMRect) => void
  onKeycodeAdd: () => void
  onMaskPartClick?: (keycodeIndex: number, part: 'outer' | 'inner') => void
  selectButton?: React.ReactNode
  focusMode?: boolean
}

export function defaultAction(type: ActionType): MacroAction {
  switch (type) {
    case 'text':
      return { type: 'text', text: '' }
    case 'tap':
    case 'down':
    case 'up':
      return { type, keycodes: [1] }
    case 'delay':
      return { type: 'delay', delay: 100 }
  }
}

export function MacroActionItem({
  action,
  index,
  onChange,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dropIndicator,
  selectedKeycodeIndex,
  selectedMaskPart,
  onKeycodeClick,
  onKeycodeDoubleClick,
  onKeycodeAdd,
  onMaskPartClick,
  selectButton,
  focusMode,
}: Props) {
  const { t } = useTranslation()

  const typeLabels: Record<ActionType, string> = {
    text: t('editor.macro.text'),
    tap: t('editor.macro.tap'),
    down: t('editor.macro.down'),
    up: t('editor.macro.up'),
    delay: t('editor.macro.delay'),
  }

  const renderContent = () => {
    switch (action.type) {
      case 'text': {
        const valid = isValidMacroText(action.text)
        return (
          <div className="flex-1">
            <input
              type="text"
              value={action.text}
              onChange={(e) => onChange(index, { type: 'text', text: e.target.value })}
              placeholder={t('editor.macro.text')}
              className={`w-full rounded border px-2 py-1 text-sm ${valid ? 'border-edge' : 'border-danger'}`}
            />
            {!valid && (
              <p className="mt-0.5 text-xs text-danger">{t('editor.macro.asciiOnly')}</p>
            )}
          </div>
        )
      }
      case 'tap':
      case 'down':
      case 'up':
        return (
          <div className="flex flex-wrap items-center gap-1 flex-1">
            {action.keycodes.map((kc, ki) => {
              const isSelected = selectedKeycodeIndex === ki
              return (
                <KeycodeField
                  key={ki}
                  value={kc}
                  selected={isSelected}
                  selectedMaskPart={isSelected && selectedMaskPart}
                  onSelect={() => onKeycodeClick(ki)}
                  onMaskPartClick={onMaskPartClick ? (part) => onMaskPartClick(ki, part) : undefined}
                  onDoubleClick={isSelected ? (rect) => onKeycodeDoubleClick(ki, rect) : undefined}
                />
              )
            })}
            {selectButton}
            <button
              type="button"
              data-testid="macro-add-keycode"
              style={{ width: KEYCODE_FIELD_SIZE, height: KEYCODE_FIELD_SIZE }}
              className="flex items-center justify-center rounded border border-dashed border-edge text-content-muted hover:border-accent hover:text-accent"
              onClick={onKeycodeAdd}
              title={t('editor.macro.addKeycode')}
            >
              +
            </button>
          </div>
        )
      case 'delay':
        return (
          <div className="flex flex-1 items-center gap-1">
            <input
              type="number"
              min={0}
              max={65535}
              value={action.delay}
              onChange={(e) =>
                onChange(index, {
                  type: 'delay',
                  delay: Math.max(0, parseInt(e.target.value, 10) || 0),
                })
              }
              className="w-24 rounded border border-edge px-2 py-1 text-sm"
            />
            <span className="text-sm text-content-secondary">ms</span>
          </div>
        )
    }
  }

  const isKeycodeType = action.type === 'tap' || action.type === 'down' || action.type === 'up'

  if (focusMode && isKeycodeType && selectedKeycodeIndex !== null) {
    const kc = action.keycodes[selectedKeycodeIndex]
    return (
      <div className="flex items-center gap-3">
        <label className="min-w-[140px] text-sm text-content">{typeLabels[action.type]}</label>
        <KeycodeField
          value={kc ?? 0}
          selected
          selectedMaskPart={selectedMaskPart}
          onSelect={() => onKeycodeClick(selectedKeycodeIndex)}
          onMaskPartClick={onMaskPartClick ? (part) => onMaskPartClick(selectedKeycodeIndex, part) : undefined}
          onDoubleClick={(rect) => onKeycodeDoubleClick(selectedKeycodeIndex, rect)}
        />
        {selectButton}
      </div>
    )
  }

  return (
    <div
      onDragOver={onDragOver}
      onDrop={(e) => { e.preventDefault(); onDrop() }}
      className={`flex items-center gap-2 rounded border border-edge bg-surface-alt px-2 py-1.5 ${dropIndicator === 'above' ? 'border-t-2 border-t-accent' : dropIndicator === 'below' ? 'border-b-2 border-b-accent' : ''}`}
    >
      <div
        draggable
        data-testid="drag-handle"
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); onDragStart() }}
        onDragEnd={onDragEnd}
        className="flex items-center gap-1.5 border-r border-edge py-1 pl-1 pr-3 cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="shrink-0 text-content-muted" size={14} />
        <span className="min-w-[36px] text-center text-sm text-content-secondary">
          {typeLabels[action.type]}
        </span>
      </div>

      {renderContent()}

      <button
        type="button"
        onClick={() => onDelete(index)}
        className="px-1.5 text-content-muted hover:text-danger"
      >
        &times;
      </button>
    </div>
  )
}
