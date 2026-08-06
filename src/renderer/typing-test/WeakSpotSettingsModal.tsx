// SPDX-License-Identifier: GPL-2.0-or-later
// Weak Spot Training Mode settings: a static explanation of the three
// detection signals (with the CURRENTLY configured values interpolated, so
// the copy never goes stale after a parameter change), the enable toggle,
// and every tunable parameter. Live detection status (the "Weak spots
// detected"/"No weak spots" line) lives below the Data section's button in
// TypingTestPaneSettingsPanel instead of in here — see that component.
// Opened from the same button, shown for every mode (not just words/time —
// the modal itself explains why it's inert elsewhere) so the explanation
// stays reachable regardless of the active mode. See RomajiSettingsModal
// for the sibling dialog-trigger/modal-skeleton convention this follows.

import { useCallback, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../hooks/useEscapeClose'
import { ModalCloseButton } from '../components/editors/ModalCloseButton'
import { MODAL_LG } from '../components/editors/store-modal-shared'
import { SettingsToggleRow } from '../components/editors/modal-controls'
import { optionButtonClass } from './TypingTestSettingsBar'
import type { TypingTestConfig, WeakSpotDetailSettings, WeakSpotMissWindow, WeakSpotDecayHalfLife } from './types'
import { hasWeakSpotFields, MAX_TYPING_TEST_RESULTS } from './types'
import type { WeakSpotGateInfo } from './weak-spot-profile'
import {
  resolveWeakSpotSettings, pruneWeakSpotSettings, WEAK_SPOT_FIELD_SPECS,
  WEAK_SPOT_MISS_WINDOW_OPTIONS, WEAK_SPOT_DECAY_HALF_LIFE_OPTIONS,
} from './weak-spot-settings'
import type { WeakSpotFieldSpec } from './weak-spot-settings'

/** The 6 numeric-field option-button rows, in display order — each pulls
 *  its option list/default straight from `WEAK_SPOT_FIELD_SPECS`, so this
 *  only needs to carry what the spec table doesn't know: the testid
 *  prefix. The i18n label key is derived (`${key}Label`) rather than
 *  spelled out per field — every field's label key in every locale pack
 *  follows this exact convention (`missThresholdLabel`,
 *  `slownessRatioLabel`, ...). `biasRatio` is listed separately below (its
 *  own section) but rendered through the same `FieldButtonRow`. */
const DETECTION_BUTTON_FIELDS: readonly { key: 'missThreshold' | 'slownessRatio' | 'stallRate' | 'stallMultiple' | 'minTimingSamples'; testId: string }[] = [
  { key: 'missThreshold', testId: 'weak-spot-miss-threshold' },
  { key: 'slownessRatio', testId: 'weak-spot-slowness-ratio' },
  { key: 'stallRate', testId: 'weak-spot-stall-rate' },
  { key: 'stallMultiple', testId: 'weak-spot-stall-multiple' },
  { key: 'minTimingSamples', testId: 'weak-spot-min-timing-samples' },
]

/** Converts a field's actual (persisted-unit) value to the number shown on
 *  its option buttons — a plain passthrough, except a `percent` field
 *  (stallRate/biasRatio, stored as a 0..1 fraction) is scaled ×100 for
 *  display. */
function toButtonValue(spec: WeakSpotFieldSpec<number>, value: number): number {
  return spec.percent ? Math.round(value * 100) : value
}

/** One option-button row: a button per `options` entry, active-highlighted
 *  when it equals `value` — the shared renderer for every tunable
 *  parameter in this modal (the 6 formerly-`<select>` numeric fields via
 *  `FieldButtonRow` below, plus Rolling window and Time decay, which
 *  render through this component directly since their option sets aren't
 *  plain numbers). Each button carries `aria-pressed` so a screen reader
 *  announces the current selection the same way a native toggle-button
 *  group would. `groupLabelledBy`, when given, marks the row as a
 *  `role="group"` labelled by that id (see `FieldButtonRow`, the only
 *  current caller that passes it — Rolling window/Time decay render this
 *  directly without it since their own preceding `<span>` isn't wired up
 *  as a labelling id). */
function OptionButtonRow<T extends number | string>({
  options, value, onChange, testIdPrefix, renderLabel, groupLabelledBy,
}: {
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  testIdPrefix: string
  renderLabel: (option: T) => ReactNode
  groupLabelledBy?: string
}) {
  return (
    <div
      className="flex flex-wrap gap-1"
      role={groupLabelledBy ? 'group' : undefined}
      aria-labelledby={groupLabelledBy}
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          data-testid={`${testIdPrefix}-${option}`}
          className={optionButtonClass(value === option, 'px-2.5')}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {renderLabel(option)}
        </button>
      ))}
    </div>
  )
}

/** One spec-driven numeric option-button row: label + `OptionButtonRow`,
 *  all sourced from `spec` — the single per-field table every parameter
 *  control derives from (see weak-spot-settings.ts). Percent conversion is
 *  applied/undone here so callers only ever read/write the field's actual
 *  persisted unit. The label `<span>` carries an id that the button group
 *  below points back to via `role="group"`/`aria-labelledby`, so a screen
 *  reader announces the field name ("Miss threshold (times)") when
 *  entering the group instead of just a bare "button, pressed". */
function FieldButtonRow({
  testIdPrefix, label, spec, value, onChange,
}: {
  testIdPrefix: string
  label: string
  spec: WeakSpotFieldSpec<number>
  value: number
  onChange: (value: number) => void
}) {
  const labelId = `${testIdPrefix}-label`
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-sm text-content-muted">{label}</span>
      <OptionButtonRow
        options={spec.options.map((option) => toButtonValue(spec, option))}
        value={toButtonValue(spec, value)}
        onChange={(selected) => onChange(spec.percent ? selected / 100 : selected)}
        testIdPrefix={testIdPrefix}
        renderLabel={(option) => option}
        groupLabelledBy={labelId}
      />
    </div>
  )
}

interface Props {
  config: TypingTestConfig
  onConfigChange: (config: TypingTestConfig) => void
  /** Live gate (see useTypingTest's own field of the same name) — decides
   *  whether the enable toggle's ON direction is currently reachable (see
   *  the toggle's own doc comment below for the OFF-is-always-possible
   *  exception). The status line it also drives is rendered by
   *  TypingTestPaneSettingsPanel, not here. */
  weakSpotGate: WeakSpotGateInfo
  onClose: () => void
}

export function WeakSpotSettingsModal({ config, onConfigChange, weakSpotGate, onClose }: Props) {
  const { t } = useTranslation()
  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeClose(onClose)

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }, [onClose])

  const applicable = hasWeakSpotFields(config)
  const weakSpotRaw: WeakSpotDetailSettings | undefined = applicable ? config.weakSpot : undefined
  const enabledOn = applicable && config.weakSpotTrainingMode === true
  const resolved = resolveWeakSpotSettings(weakSpotRaw)

  // "ON" is gated on the live detection gate; "OFF" is ALWAYS reachable —
  // a parameter change that drops the gate back out of 'active' (e.g.
  // raising missThreshold past what History currently supports) must
  // never strand the toggle on with no way to turn it back off.
  const enableDisabled = !applicable || (!enabledOn && weakSpotGate.status !== 'active')

  const handleToggleEnable = useCallback(() => {
    if (!hasWeakSpotFields(config)) return
    onConfigChange({ ...config, weakSpotTrainingMode: !(config.weakSpotTrainingMode === true) })
  }, [config, onConfigChange])

  const applyWeakSpot = useCallback((patch: Partial<WeakSpotDetailSettings>) => {
    if (!hasWeakSpotFields(config)) return
    const merged = pruneWeakSpotSettings({ ...config.weakSpot, ...patch })
    // Clicking the already-selected button re-derives the SAME pruned
    // subtree (e.g. clicking a default-value button when the field was
    // already absent) — a no-op that must not reach onConfigChange. See
    // isOnlyWeakSpotTuningChange's own doc comment for why this matters:
    // an identical-config setConfig call is NOT itself treated as a no-op
    // there (it's relied on elsewhere to mint a fresh run), so a click that
    // changes nothing must never get that far in the first place.
    if (JSON.stringify(merged) === JSON.stringify(config.weakSpot)) return
    const { weakSpot: _current, ...rest } = config
    onConfigChange(merged ? { ...rest, weakSpot: merged } : rest)
  }, [config, onConfigChange])

  const handleReset = useCallback(() => {
    if (!hasWeakSpotFields(config)) return
    if (config.weakSpot === undefined) return // already at defaults — nothing to reset
    const { weakSpot: _current, ...rest } = config
    onConfigChange(rest)
  }, [config, onConfigChange])

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="weak-spot-settings-title"
      onClick={handleBackdropClick}
      data-testid="weak-spot-settings-modal"
    >
      <div className={`flex max-h-modal-90vh flex-col ${MODAL_LG} rounded-2xl border border-edge bg-surface-alt shadow-xl`}>
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 id="weak-spot-settings-title" className="text-lg font-semibold text-content">
            {t('editor.typingTest.weakSpotSettings.title')}
          </h2>
          <ModalCloseButton testid="weak-spot-settings-modal-close" onClick={onClose} />
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <section className="flex flex-col gap-2 rounded-lg border border-edge bg-surface/20 p-3">
            <p className="text-xs text-content-secondary">
              {t('editor.typingTest.weakSpotSettings.description', {
                missThreshold: resolved.missThreshold,
                minTimingSamples: resolved.minTimingSamples,
                slownessRatio: resolved.slownessRatio,
                stallMultiple: resolved.stallMultiple,
                stallRatePercent: Math.round(resolved.stallRate * 100),
              })}
            </p>
            <p className="text-xs text-content-secondary">
              {resolved.missWindow === 'all'
                ? t('editor.typingTest.weakSpotSettings.windowDescriptionAll')
                : t('editor.typingTest.weakSpotSettings.windowDescription', { count: resolved.missWindow })}
            </p>
            {resolved.decayHalfLifeDays !== 'none' && (
              <p className="text-xs text-content-secondary">
                {t('editor.typingTest.weakSpotSettings.decayDescription', { days: resolved.decayHalfLifeDays })}
              </p>
            )}
            <p className="text-xs text-content-secondary">
              {t('editor.typingTest.weakSpotSettings.biasDescription', { percent: Math.round(resolved.biasRatio * 100) })}
            </p>
            <p className="text-xs text-content-muted" data-testid="weak-spot-history-retention-note">
              {t('editor.typingTest.weakSpotSettings.historyRetentionNote', { max: MAX_TYPING_TEST_RESULTS })}
            </p>
          </section>

          <SettingsToggleRow
            rowTestId="weak-spot-enable-toggle-row"
            toggleTestId="weak-spot-enable-toggle"
            label={t('editor.typingTest.weakSpotTraining')}
            labelTone="content"
            on={enabledOn}
            onToggle={handleToggleEnable}
            disabled={enableDisabled}
          />

          {!applicable && (
            <p className="text-xs text-content-muted" data-testid="weak-spot-not-applicable-note">
              {t('editor.typingTest.weakSpotSettings.notApplicableNote')}
            </p>
          )}

          {applicable && (
          <>
          <section className="flex flex-col gap-3">
            <span className="text-sm font-semibold text-content">{t('editor.typingTest.weakSpotSettings.sectionDetection')}</span>

            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              {DETECTION_BUTTON_FIELDS.map(({ key, testId }) => (
                <FieldButtonRow
                  key={key}
                  testIdPrefix={testId}
                  label={t(`editor.typingTest.weakSpotSettings.${key}Label`)}
                  spec={WEAK_SPOT_FIELD_SPECS[key]}
                  value={resolved[key]}
                  onChange={(value) => applyWeakSpot({ [key]: value } as Partial<WeakSpotDetailSettings>)}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <span className="text-sm font-semibold text-content">{t('editor.typingTest.weakSpotSettings.sectionWindow')}</span>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <div className="flex flex-col gap-1">
                <span className="text-sm text-content-muted">{t('editor.typingTest.weakSpotSettings.missWindowLabel')}</span>
                <OptionButtonRow
                  options={WEAK_SPOT_MISS_WINDOW_OPTIONS}
                  value={resolved.missWindow as WeakSpotMissWindow}
                  onChange={(missWindow) => applyWeakSpot({ missWindow })}
                  testIdPrefix="weak-spot-miss-window"
                  renderLabel={(value) => (value === 'all' ? t('editor.typingTest.weakSpotSettings.missWindowAll') : value)}
                />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-sm text-content-muted">{t('editor.typingTest.weakSpotSettings.decayLabel')}</span>
                <OptionButtonRow
                  options={WEAK_SPOT_DECAY_HALF_LIFE_OPTIONS}
                  value={resolved.decayHalfLifeDays as WeakSpotDecayHalfLife}
                  onChange={(decayHalfLifeDays) => applyWeakSpot({ decayHalfLifeDays })}
                  testIdPrefix="weak-spot-decay"
                  renderLabel={(value) => (value === 'none' ? t('editor.typingTest.weakSpotSettings.decayNone') : value)}
                />
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-content">{t('editor.typingTest.weakSpotSettings.sectionSampling')}</span>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <FieldButtonRow
                testIdPrefix="weak-spot-bias-ratio"
                label={t('editor.typingTest.weakSpotSettings.biasRatioLabel')}
                spec={WEAK_SPOT_FIELD_SPECS.biasRatio}
                value={resolved.biasRatio}
                onChange={(biasRatio) => applyWeakSpot({ biasRatio })}
              />
            </div>
          </section>

          <button
            type="button"
            data-testid="weak-spot-settings-reset"
            className={`${optionButtonClass(false, 'px-2.5')} self-start`}
            onClick={handleReset}
          >
            {t('editor.typingTest.weakSpotSettings.resetButton')}
          </button>
          </>
          )}
        </div>
      </div>
    </div>
  )
}
