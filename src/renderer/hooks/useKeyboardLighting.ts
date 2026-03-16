// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback } from 'react'
import {
  QMK_BACKLIGHT_BRIGHTNESS,
  QMK_BACKLIGHT_EFFECT,
  QMK_RGBLIGHT_BRIGHTNESS,
  QMK_RGBLIGHT_EFFECT,
  QMK_RGBLIGHT_EFFECT_SPEED,
  QMK_RGBLIGHT_COLOR,
} from '../../shared/constants/protocol'
import { normalizeQmkSettingData } from '../../shared/qmk-settings-normalize'
import type { SetState, KeyboardState } from './keyboard-types'

export function useKeyboardLighting(
  setState: SetState,
  stateRef: React.MutableRefObject<KeyboardState>,
  bumpActivity: () => void,
) {
  const setBacklightBrightness = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_BACKLIGHT_BRIGHTNESS, v)
    }
    setState((s) => ({ ...s, backlightBrightness: v }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setBacklightEffect = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_BACKLIGHT_EFFECT, v)
    }
    setState((s) => ({ ...s, backlightEffect: v }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setRgblightBrightness = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_BRIGHTNESS, v)
    }
    setState((s) => ({ ...s, rgblightBrightness: v }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setRgblightEffect = useCallback(async (index: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_EFFECT, index)
    }
    setState((s) => ({ ...s, rgblightEffect: index }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setRgblightEffectSpeed = useCallback(async (v: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_EFFECT_SPEED, v)
    }
    setState((s) => ({ ...s, rgblightEffectSpeed: v }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setRgblightColor = useCallback(async (h: number, s: number) => {
    if (!stateRef.current.isDummy) {
      await window.vialAPI.setLightingValue(QMK_RGBLIGHT_COLOR, h, s)
    }
    setState((prev) => ({ ...prev, rgblightHue: h, rgblightSat: s }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setVialRGBMode = useCallback(async (mode: number) => {
    const s = stateRef.current
    if (!s.isDummy) {
      await window.vialAPI.setVialRGBMode(mode, s.vialRGBSpeed, s.vialRGBHue, s.vialRGBSat, s.vialRGBVal)
    }
    setState((prev) => ({ ...prev, vialRGBMode: mode }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setVialRGBSpeed = useCallback(async (speed: number) => {
    const s = stateRef.current
    if (!s.isDummy) {
      await window.vialAPI.setVialRGBMode(s.vialRGBMode, speed, s.vialRGBHue, s.vialRGBSat, s.vialRGBVal)
    }
    setState((prev) => ({ ...prev, vialRGBSpeed: speed }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setVialRGBColor = useCallback(async (h: number, s: number) => {
    const st = stateRef.current
    if (!st.isDummy) {
      await window.vialAPI.setVialRGBMode(st.vialRGBMode, st.vialRGBSpeed, h, s, st.vialRGBVal)
    }
    setState((prev) => ({ ...prev, vialRGBHue: h, vialRGBSat: s }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setVialRGBBrightness = useCallback(async (v: number) => {
    const s = stateRef.current
    if (!s.isDummy) {
      await window.vialAPI.setVialRGBMode(s.vialRGBMode, s.vialRGBSpeed, s.vialRGBHue, s.vialRGBSat, v)
    }
    setState((prev) => ({ ...prev, vialRGBVal: v }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const setVialRGBHSV = useCallback(async (h: number, s: number, v: number) => {
    const st = stateRef.current
    if (!st.isDummy) {
      await window.vialAPI.setVialRGBMode(st.vialRGBMode, st.vialRGBSpeed, h, s, v)
    }
    setState((prev) => ({ ...prev, vialRGBHue: h, vialRGBSat: s, vialRGBVal: v }))
    bumpActivity()
  }, [setState, stateRef, bumpActivity])

  const updateQmkSettingsValue = useCallback((qsid: number, data: number[]) => {
    const normalized = normalizeQmkSettingData(qsid, data)
    setState((s) => ({
      ...s,
      qmkSettingsValues: { ...s.qmkSettingsValues, [String(qsid)]: normalized },
    }))
    bumpActivity()
  }, [setState, bumpActivity])

  return {
    setBacklightBrightness,
    setBacklightEffect,
    setRgblightBrightness,
    setRgblightEffect,
    setRgblightEffectSpeed,
    setRgblightColor,
    setVialRGBMode,
    setVialRGBSpeed,
    setVialRGBColor,
    setVialRGBBrightness,
    setVialRGBHSV,
    updateQmkSettingsValue,
  }
}
