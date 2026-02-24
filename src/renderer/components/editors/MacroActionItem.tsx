// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { isValidMacroText, type MacroAction } from '../../../preload/macro'
import { KeycodeField } from './KeycodeField'

type ActionType = MacroAction['type']

interface Props {
  action: MacroAction
  index: number
  isFirst: boolean
  isLast: boolean
  onChange: (index: number, action: MacroAction) => void
  onDelete: (index: number) => void
  onMoveUp: (index: number) => void
  onMoveDown: (index: number) => void
  selectedKeycodeIndex: number | null
  selectedMaskPart?: boolean
  onKeycodeClick: (keycodeIndex: number) => void
  onKeycodeDoubleClick: (keycodeIndex: number, rect: DOMRect) => void
  onKeycodeAdd: () => void
  onMaskPartClick?: (keycodeIndex: number, part: 'outer' | 'inner') => void
  selectButton?: React.ReactNode
}

const ACTION_TYPES: ActionType[] = ['text', 'tap', 'down', 'up', 'delay']

function defaultAction(type: ActionType): MacroAction {
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
  isFirst,
  isLast,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  selectedKeycodeIndex,
  selectedMaskPart,
  onKeycodeClick,
  onKeycodeDoubleClick,
  onKeycodeAdd,
  onMaskPartClick,
  selectButton,
}: Props) {
  const { t } = useTranslation()

  const typeLabels: Record<ActionType, string> = {
    text: t('editor.macro.text'),
    tap: t('editor.macro.tap'),
    down: t('editor.macro.down'),
    up: t('editor.macro.up'),
    delay: t('editor.macro.delay'),
  }

  const handleTypeChange = (newType: ActionType) => {
    if (newType !== action.type) {
      onChange(index, defaultAction(newType))
    }
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
            {action.keycodes.map((kc, ki) => (
              <KeycodeField
                key={ki}
                value={kc}
                selected={selectedKeycodeIndex === ki}
                selectedMaskPart={selectedKeycodeIndex === ki && selectedMaskPart}
                onSelect={() => onKeycodeClick(ki)}
                onMaskPartClick={onMaskPartClick ? (part) => onMaskPartClick(ki, part) : undefined}
                onDoubleClick={selectedKeycodeIndex === ki ? (rect) => onKeycodeDoubleClick(ki, rect) : undefined}
              />
            ))}
            {selectButton}
            <button
              type="button"
              data-testid="macro-add-keycode"
              className="flex items-center justify-center w-[44px] h-[44px] rounded border border-dashed border-edge text-content-muted hover:border-accent hover:text-accent"
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

  return (
    <div className="flex items-center gap-2 rounded border border-edge bg-surface-alt px-2 py-1.5">
      {/* Move up/down */}
      <div className="flex flex-col">
        <button
          type="button"
          disabled={isFirst}
          onClick={() => onMoveUp(index)}
          className="px-1 text-xs text-content-muted hover:text-content disabled:opacity-30"
        >
          &#9650;
        </button>
        <button
          type="button"
          disabled={isLast}
          onClick={() => onMoveDown(index)}
          className="px-1 text-xs text-content-muted hover:text-content disabled:opacity-30"
        >
          &#9660;
        </button>
      </div>

      {/* Type selector */}
      <select
        value={action.type}
        onChange={(e) => handleTypeChange(e.target.value as ActionType)}
        className="rounded border border-edge bg-surface px-1.5 py-1 text-sm"
      >
        {ACTION_TYPES.map((type) => (
          <option key={type} value={type}>
            {typeLabels[type]}
          </option>
        ))}
      </select>

      {/* Content */}
      {renderContent()}

      {/* Remove */}
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
