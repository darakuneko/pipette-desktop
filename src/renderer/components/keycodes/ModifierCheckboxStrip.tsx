// SPDX-License-Identifier: GPL-2.0-or-later

interface Props {
  modMask: number
  onChange: (newMask: number) => void
}

const RIGHT_BIT = 1 << 4
const MOD_BITS_MASK = 0x0f
const FULL_MASK = 0x1f

const MODS = [
  { key: 'Ctl', bit: 0 },
  { key: 'Sft', bit: 1 },
  { key: 'Alt', bit: 2 },
  { key: 'Gui', bit: 3 },
] as const

export function ModifierCheckboxStrip({ modMask, onChange }: Props) {
  const isRight = (modMask & RIGHT_BIT) !== 0
  const hasAnyMod = (modMask & MOD_BITS_MASK) !== 0

  const toggle = (bit: number, right: boolean) => {
    const toggled = modMask ^ (1 << bit)
    const hasMods = (toggled & MOD_BITS_MASK) !== 0
    const withSide = right && hasMods ? toggled | RIGHT_BIT : toggled & ~RIGHT_BIT
    onChange(withSide & FULL_MASK)
  }

  const renderRow = (right: boolean) => {
    const prefix = right ? 'R' : 'L'
    const disabled = hasAnyMod && right !== isRight

    return (
      <div className="flex items-center gap-1" role="group" aria-label={right ? 'Right modifiers' : 'Left modifiers'}>
        {MODS.map(({ key, bit }) => {
          const active = right === isRight && (modMask & (1 << bit)) !== 0
          const label = `${prefix}${key}`
          return (
            <button
              key={label}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => toggle(bit, right)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                active
                  ? 'bg-accent text-content-inverse'
                  : disabled
                    ? 'cursor-not-allowed bg-surface-dim text-content-muted'
                    : 'bg-surface-dim text-content-secondary hover:bg-edge'
              }`}
              data-testid={`mod-${label}`}
            >
              {label}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1" data-testid="modifier-checkbox-strip">
      {renderRow(false)}
      {renderRow(true)}
    </div>
  )
}
