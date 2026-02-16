// SPDX-License-Identifier: GPL-2.0-or-later

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HSVColorPicker, hsvToRgb, rgbToHsv, rgbToHex, hexToRgb } from './HSVColorPicker'
import { QMK_RGBLIGHT_EFFECTS, VIALRGB_EFFECTS } from '../../../shared/constants/lighting'

interface Props {
  lightingType: string | undefined
  // QMK Backlight
  backlightBrightness: number
  backlightEffect: number
  // QMK RGBlight
  rgblightBrightness: number
  rgblightEffect: number
  rgblightEffectSpeed: number
  rgblightHue: number
  rgblightSat: number
  // VialRGB
  vialRGBVersion: number
  vialRGBMode: number
  vialRGBSpeed: number
  vialRGBHue: number
  vialRGBSat: number
  vialRGBVal: number
  vialRGBMaxBrightness: number
  vialRGBSupported: number[]
  // Callbacks
  onSetBacklightBrightness: (v: number) => Promise<void>
  onSetBacklightEffect: (v: number) => Promise<void>
  onSetRgblightBrightness: (v: number) => Promise<void>
  onSetRgblightEffect: (index: number) => Promise<void>
  onSetRgblightEffectSpeed: (v: number) => Promise<void>
  onSetRgblightColor: (h: number, s: number) => Promise<void>
  onSetVialRGBMode: (mode: number) => Promise<void>
  onSetVialRGBSpeed: (speed: number) => Promise<void>
  onSetVialRGBColor: (h: number, s: number) => Promise<void>
  onSetVialRGBBrightness: (v: number) => Promise<void>
  onSetVialRGBHSV: (h: number, s: number, v: number) => Promise<void>
  onSave: () => Promise<void>
}

const INPUT_CLASS = 'rounded border border-edge bg-transparent px-1.5 py-0.5 font-mono text-xs'

function ColorCodeFields({
  hue,
  saturation,
  brightness,
  onApplyHsv,
}: {
  hue: number
  saturation: number
  brightness: number
  onApplyHsv: (h: number, s: number, v: number) => void
}) {
  const { t } = useTranslation()
  const [localHex, setLocalHex] = useState<string | null>(null)
  const hexStr = rgbToHex(...hsvToRgb(hue, saturation, brightness))

  function commitHex(): void {
    if (localHex !== null) {
      const parsed = hexToRgb(localHex)
      if (parsed) onApplyHsv(...rgbToHsv(...parsed))
      setLocalHex(null)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <label className="min-w-[100px] text-sm">{t('editor.lighting.hex')}</label>
      <div className="flex items-center gap-1 text-xs">
        <span className="text-content-muted">#</span>
        <input
          data-testid="hex-input"
          className={`${INPUT_CLASS} w-[4.5rem]`}
          value={localHex ?? hexStr.slice(1)}
          maxLength={6}
          onFocus={() => setLocalHex(hexStr.slice(1))}
          onChange={(e) => setLocalHex(e.target.value.replace(/^#/, ''))}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setLocalHex(null)
              e.currentTarget.blur()
            }
          }}
        />
      </div>
    </div>
  )
}

function RGBLightingColorCode({
  hue,
  saturation,
  brightness,
  onSetColor,
  onSetBrightness,
}: {
  hue: number
  saturation: number
  brightness: number
  onSetColor: (h: number, s: number) => Promise<void>
  onSetBrightness: (v: number) => Promise<void>
}) {
  return (
    <ColorCodeFields
      hue={hue}
      saturation={saturation}
      brightness={brightness}
      onApplyHsv={async (h, s, v) => {
        await onSetColor(h, s)
        await onSetBrightness(v)
      }}
    />
  )
}

function VialRGBColorCode({
  hue,
  saturation,
  brightness,
  maxBrightness,
  onSetHSV,
}: {
  hue: number
  saturation: number
  brightness: number
  maxBrightness: number
  onSetHSV: (h: number, s: number, v: number) => Promise<void>
}) {
  return (
    <ColorCodeFields
      hue={hue}
      saturation={saturation}
      brightness={brightness}
      onApplyHsv={async (h, s, v) => {
        await onSetHSV(h, s, Math.min(v, maxBrightness))
      }}
    />
  )
}

export function RGBConfigurator({
  lightingType,
  backlightBrightness,
  backlightEffect,
  rgblightBrightness,
  rgblightEffect,
  rgblightEffectSpeed,
  rgblightHue,
  rgblightSat,
  vialRGBVersion,
  vialRGBMode,
  vialRGBSpeed,
  vialRGBHue,
  vialRGBSat,
  vialRGBVal,
  vialRGBMaxBrightness,
  vialRGBSupported,
  onSetBacklightBrightness,
  onSetBacklightEffect,
  onSetRgblightBrightness,
  onSetRgblightEffect,
  onSetRgblightEffectSpeed,
  onSetRgblightColor,
  onSetVialRGBMode,
  onSetVialRGBSpeed,
  onSetVialRGBColor,
  onSetVialRGBBrightness,
  onSetVialRGBHSV,
  onSave,
}: Props) {
  const { t } = useTranslation()

  // Snapshot of all lighting values for unsaved-change detection.
  // Placed before the early return so the useRef call is never conditional.
  const currentValues = {
    backlightBrightness,
    backlightEffect,
    rgblightBrightness,
    rgblightEffect,
    rgblightEffectSpeed,
    rgblightHue,
    rgblightSat,
    vialRGBMode,
    vialRGBSpeed,
    vialRGBHue,
    vialRGBSat,
    vialRGBVal,
  }

  type LightingSnapshot = typeof currentValues
  const savedRef = useRef<LightingSnapshot>(currentValues)

  if (!lightingType || lightingType === 'none') {
    return (
      <div className="p-4 text-content-muted" data-testid="editor-lighting">
        {t('editor.lighting.noLighting')}
      </div>
    )
  }

  const hasBacklight =
    lightingType === 'qmk_backlight' || lightingType === 'qmk_backlight_rgblight'
  const hasRGBlight =
    lightingType === 'qmk_rgblight' || lightingType === 'qmk_backlight_rgblight'
  const hasVialRGB = lightingType === 'vialrgb' && vialRGBVersion === 1
  const sectionCount = Number(hasBacklight) + Number(hasRGBlight) + Number(hasVialRGB)

  const isDirty = (Object.keys(savedRef.current) as (keyof LightingSnapshot)[]).some(
    (k) => currentValues[k] !== savedRef.current[k],
  )

  async function restoreSavedValues(): Promise<void> {
    const s = savedRef.current
    try {
      if (hasBacklight) {
        await onSetBacklightBrightness(s.backlightBrightness)
        await onSetBacklightEffect(s.backlightEffect)
      }
      if (hasRGBlight) {
        await onSetRgblightEffect(s.rgblightEffect)
        await onSetRgblightBrightness(s.rgblightBrightness)
        await onSetRgblightEffectSpeed(s.rgblightEffectSpeed)
        await onSetRgblightColor(s.rgblightHue, s.rgblightSat)
      }
      if (hasVialRGB) {
        await onSetVialRGBMode(s.vialRGBMode)
        await onSetVialRGBSpeed(s.vialRGBSpeed)
        await onSetVialRGBColor(s.vialRGBHue, s.vialRGBSat)
        await onSetVialRGBBrightness(s.vialRGBVal)
      }
    } catch (err) {
      console.error('[Lighting] undo failed:', err)
    }
  }

  const selectedRgblightEffect = QMK_RGBLIGHT_EFFECTS.find((e) => e.index === rgblightEffect)
  const supportedSet = new Set(vialRGBSupported)
  const filteredVialRGBEffects = VIALRGB_EFFECTS.filter((e) => supportedSet.has(e.index))

  return (
    <div className="flex max-w-md flex-col gap-6" data-testid="editor-lighting">
      {/* Backlight Section */}
      {hasBacklight && (
        <section className="flex flex-col gap-3">
          {sectionCount > 1 && (
            <h3 className="text-base font-medium">{t('editor.lighting.backlight')}</h3>
          )}

          <div className="flex items-center gap-3">
            <label className="min-w-[100px] text-sm">{t('editor.lighting.brightness')}</label>
            <input
              type="range"
              min={0}
              max={255}
              value={backlightBrightness}
              onChange={async (e) => {
                await onSetBacklightBrightness(Number(e.target.value))
              }}
              className="flex-1"
            />
            <span className="w-10 text-right text-sm">{backlightBrightness}</span>
          </div>

          <div className="flex items-center gap-3">
            <label className="min-w-[100px] text-sm">{t('editor.lighting.breathing')}</label>
            <input
              type="checkbox"
              checked={backlightEffect === 1}
              onChange={async (e) => {
                await onSetBacklightEffect(e.target.checked ? 1 : 0)
              }}
              className="h-4 w-4"
            />
          </div>
        </section>
      )}

      {/* RGBlight Section */}
      {hasRGBlight && (
        <section className="flex flex-col gap-3">
          {sectionCount > 1 && (
            <h3 className="text-base font-medium">{t('editor.lighting.rgblight')}</h3>
          )}

          <div className="flex items-center gap-3">
            <label className="min-w-[100px] text-sm">{t('editor.lighting.effect')}</label>
            <select
              value={rgblightEffect}
              onChange={async (e) => {
                await onSetRgblightEffect(Number(e.target.value))
              }}
              className="flex-1 rounded border border-edge bg-surface px-2 py-1 text-sm"
            >
              {QMK_RGBLIGHT_EFFECTS.map((fx) => (
                <option key={fx.index} value={fx.index}>
                  {fx.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <label className="min-w-[100px] text-sm">{t('editor.lighting.speed')}</label>
            <input
              type="range"
              min={0}
              max={255}
              value={rgblightEffectSpeed}
              onChange={async (e) => {
                await onSetRgblightEffectSpeed(Number(e.target.value))
              }}
              className="flex-1"
            />
            <span className="w-10 text-right text-sm">{rgblightEffectSpeed}</span>
          </div>

          {selectedRgblightEffect?.hasColorPicker && (
            <>
              <div className="flex items-start gap-3">
                <label className="min-w-[100px] pt-1 text-sm">
                  {t('editor.lighting.colorPicker.label')}
                </label>
                <HSVColorPicker
                  hue={rgblightHue}
                  saturation={rgblightSat}
                  value={rgblightBrightness}
                  onHueChange={async (h) => {
                    await onSetRgblightColor(h, rgblightSat)
                  }}
                  onSaturationChange={async (s) => {
                    await onSetRgblightColor(rgblightHue, s)
                  }}
                  onValueChange={async (v) => {
                    await onSetRgblightBrightness(v)
                  }}
                  onColorChange={async (h, s, v) => {
                    await onSetRgblightColor(h, s)
                    await onSetRgblightBrightness(v)
                  }}
                />
              </div>

              <div className="flex items-center gap-3">
                <label className="min-w-[100px] text-sm">
                  {t('editor.lighting.brightness')}
                </label>
                <input
                  type="range"
                  min={0}
                  max={255}
                  value={rgblightBrightness}
                  onChange={async (e) => {
                    await onSetRgblightBrightness(Number(e.target.value))
                  }}
                  className="flex-1"
                />
                <span className="w-10 text-right text-sm">{rgblightBrightness}</span>
              </div>

              <RGBLightingColorCode
                hue={rgblightHue}
                saturation={rgblightSat}
                brightness={rgblightBrightness}
                onSetColor={onSetRgblightColor}
                onSetBrightness={onSetRgblightBrightness}
              />
            </>
          )}
        </section>
      )}

      {/* VialRGB Section */}
      {hasVialRGB && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="min-w-[100px] text-sm">{t('editor.lighting.effect')}</label>
            <select
              value={vialRGBMode}
              onChange={async (e) => {
                await onSetVialRGBMode(Number(e.target.value))
              }}
              className="flex-1 rounded border border-edge bg-surface px-2 py-1 text-sm"
            >
              {filteredVialRGBEffects.map((fx) => (
                <option key={fx.index} value={fx.index}>
                  {fx.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <label className="min-w-[100px] text-sm">{t('editor.lighting.speed')}</label>
            <input
              type="range"
              min={0}
              max={255}
              value={vialRGBSpeed}
              onChange={async (e) => {
                await onSetVialRGBSpeed(Number(e.target.value))
              }}
              className="flex-1"
            />
            <span className="w-10 text-right text-sm">{vialRGBSpeed}</span>
          </div>

          <div className="flex items-start gap-3">
            <label className="min-w-[100px] pt-1 text-sm">
              {t('editor.lighting.colorPicker.label')}
            </label>
            <HSVColorPicker
              hue={vialRGBHue}
              saturation={vialRGBSat}
              value={vialRGBVal}
              onHueChange={async (h) => {
                await onSetVialRGBColor(h, vialRGBSat)
              }}
              onSaturationChange={async (s) => {
                await onSetVialRGBColor(vialRGBHue, s)
              }}
              onValueChange={async (v) => {
                await onSetVialRGBBrightness(Math.min(v, vialRGBMaxBrightness))
              }}
              onColorChange={async (h, s, v) => {
                await onSetVialRGBHSV(h, s, Math.min(v, vialRGBMaxBrightness))
              }}
            />
          </div>

          <div className="flex items-center gap-3">
            <label className="min-w-[100px] text-sm">
              {t('editor.lighting.brightness')}
            </label>
            <input
              type="range"
              min={0}
              max={vialRGBMaxBrightness}
              value={vialRGBVal}
              onChange={async (e) => {
                await onSetVialRGBBrightness(Number(e.target.value))
              }}
              className="flex-1"
            />
            <span className="w-10 text-right text-sm">{vialRGBVal}</span>
          </div>

          <VialRGBColorCode
            hue={vialRGBHue}
            saturation={vialRGBSat}
            brightness={vialRGBVal}
            maxBrightness={vialRGBMaxBrightness}
            onSetHSV={onSetVialRGBHSV}
          />
        </section>
      )}

      {isDirty && (
        <p className="text-xs text-content-muted" data-testid="lighting-unsaved">
          {t('editor.lighting.unsavedPreview')}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="lighting-save"
          onClick={async () => {
            try {
              await onSave()
              savedRef.current = currentValues
            } catch (err) {
              console.error('[Lighting] save failed:', err)
            }
          }}
          className="rounded bg-accent px-4 py-1.5 text-sm text-content-inverse hover:bg-accent-hover"
        >
          {t('common.save')}
        </button>

        {isDirty && (
          <button
            type="button"
            data-testid="lighting-undo"
            onClick={restoreSavedValues}
            className="rounded border border-edge px-4 py-1.5 text-sm hover:bg-surface-hover"
          >
            {t('common.undo')}
          </button>
        )}
      </div>
    </div>
  )
}
