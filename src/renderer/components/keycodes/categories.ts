// SPDX-License-Identifier: GPL-2.0-or-later

import {
  KEYCODES_SPECIAL,
  KEYCODES_BASIC,
  KEYCODES_BASIC_CHARACTERS,
  KEYCODES_BASIC_LETTERS,
  KEYCODES_BASIC_NUMBERS,
  KEYCODES_BASIC_SYMBOLS,
  KEYCODES_BASIC_EDITING,
  KEYCODES_BASIC_MODS,
  KEYCODES_BASIC_NAV,
  KEYCODES_BASIC_FUNCTION,
  KEYCODES_BASIC_LOCK,
  KEYCODES_BASIC_NUMPAD,
  KEYCODES_BASIC_SYSTEM,
  KEYCODES_SHIFTED,
  KEYCODES_ISO,
  KEYCODES_LAYERS,
  KEYCODES_LAYERS_SPECIAL,
  KEYCODES_LAYERS_MO,
  KEYCODES_LAYERS_DF,
  KEYCODES_LAYERS_PDF,
  KEYCODES_LAYERS_TG,
  KEYCODES_LAYERS_TT,
  KEYCODES_LAYERS_OSL,
  KEYCODES_LAYERS_TO,
  KEYCODES_LAYERS_LT,
  KEYCODES_LAYERS_LM,
  KEYCODES_QUANTUM,
  KEYCODES_QUANTUM_MAGIC,
  KEYCODES_QUANTUM_AUDIO,
  KEYCODES_QUANTUM_HAPTIC,
  KEYCODES_QUANTUM_AUTOSHIFT,
  KEYCODES_QUANTUM_COMBO,
  KEYCODES_QUANTUM_KEY_OVERRIDE,
  KEYCODES_QUANTUM_REPEAT,
  KEYCODES_QUANTUM_CAPS_WORD,
  KEYCODES_BACKLIGHT,
  KEYCODES_LIGHTING_BL,
  KEYCODES_LIGHTING_RGB,
  KEYCODES_LIGHTING_MATRIX,
  KEYCODES_MEDIA,
  KEYCODES_MEDIA_FKEYS,
  KEYCODES_MEDIA_SYSTEM,
  KEYCODES_MEDIA_APP,
  KEYCODES_MEDIA_PLAYBACK,
  KEYCODES_MEDIA_MOUSE,
  KEYCODES_MEDIA_LOCK,
  KEYCODES_TAP_DANCE,
  KEYCODES_USER,
  KEYCODES_MACRO,
  KEYCODES_MACRO_BASE,
  KEYCODES_MIDI,
  KEYCODES_MIDI_BASIC,
  KEYCODES_MIDI_OCTAVE,
  KEYCODES_MIDI_TRANSPOSE,
  KEYCODES_MIDI_VELOCITY,
  KEYCODES_MIDI_CHANNEL,
  KEYCODES_MIDI_CONTROL,
  KEYCODES_MODIFIERS,
  KEYCODES_MOD_OSM,
  KEYCODES_MOD_MASK,
  KEYCODES_MOD_TAP,
  KEYCODES_MOD_SPECIAL,
  KEYCODES_BOOT,
  KEYCODES_QUANTUM_SWAP_HANDS,
  KEYCODES_QUANTUM_SWAP_HANDS_TAP,
  KEYCODES_MIDI_SEQUENCER,
  KEYCODES_MEDIA_JOYSTICK,
  KEYCODES_LIGHTING_LED_MATRIX,
  type Keycode,
} from '../../../shared/keycodes/keycodes'

export interface KeycodeGroup {
  labelKey: string // i18n key for group heading
  keycodes: Keycode[]
  sections?: Keycode[][] // render each section with a line break between them
  layoutRow?: number // consecutive groups sharing the same layoutRow render side-by-side
}

/** Collect consecutive groups that share the same layoutRow into rows for side-by-side rendering */
export function groupByLayoutRow<T extends { layoutRow?: number }>(groups: T[]): T[][] {
  const rows: T[][] = []
  for (const group of groups) {
    const prev = rows[rows.length - 1]
    if (prev != null && group.layoutRow != null && prev[0].layoutRow === group.layoutRow) {
      prev.push(group)
    } else {
      rows.push([group])
    }
  }
  return rows
}

export interface KeycodeCategory {
  id: string
  labelKey: string // i18n key
  getKeycodes: () => Keycode[]
  getGroups?: (viewType?: string) => KeycodeGroup[]
}

/** Characters group shared across all views */
function basicCharactersGroup(extra?: { layoutRow: number }): KeycodeGroup {
  return {
    labelKey: 'keycodes.group.characters',
    keycodes: KEYCODES_BASIC_CHARACTERS,
    sections: [[...KEYCODES_BASIC_NUMBERS, ...KEYCODES_BASIC_SYMBOLS], KEYCODES_BASIC_LETTERS],
    ...extra,
  }
}

/** Group ordering for LIST view — shows all groups with full context */
function getBasicGroupsList(): KeycodeGroup[] {
  return [
    basicCharactersGroup(),
    { labelKey: 'keycodes.group.editing', keycodes: KEYCODES_BASIC_EDITING, layoutRow: 1 },
    { labelKey: 'keycodes.group.function', keycodes: KEYCODES_BASIC_FUNCTION, layoutRow: 1 },
    { labelKey: 'keycodes.group.modifiers', keycodes: KEYCODES_BASIC_MODS, layoutRow: 2 },
    { labelKey: 'keycodes.group.navigation', keycodes: KEYCODES_BASIC_NAV, layoutRow: 2 },
    { labelKey: 'keycodes.group.numpad', keycodes: KEYCODES_BASIC_NUMPAD },
    { labelKey: 'keycodes.group.internal', keycodes: KEYCODES_SPECIAL, layoutRow: 3 },
    { labelKey: 'keycodes.iso', keycodes: KEYCODES_ISO, layoutRow: 3 },
    { labelKey: 'keycodes.group.lock', keycodes: KEYCODES_BASIC_LOCK, layoutRow: 3 },
    { labelKey: 'keycodes.group.system', keycodes: KEYCODES_BASIC_SYSTEM, layoutRow: 3 },
  ]
}

/** Group ordering for ANSI keyboard view — remaining keycodes below ANSI layout */
function getBasicGroupsAnsi(): KeycodeGroup[] {
  return [
    { labelKey: 'keycodes.group.numpad', keycodes: KEYCODES_BASIC_NUMPAD },
    { labelKey: 'keycodes.group.navigation', keycodes: KEYCODES_BASIC_NAV },
    { labelKey: 'keycodes.group.internal', keycodes: KEYCODES_SPECIAL, layoutRow: 1 },
    { labelKey: 'keycodes.iso', keycodes: KEYCODES_ISO, layoutRow: 1 },
    { labelKey: 'keycodes.group.lock', keycodes: KEYCODES_BASIC_LOCK, layoutRow: 2 },
    { labelKey: 'keycodes.group.system', keycodes: KEYCODES_BASIC_SYSTEM, layoutRow: 2 },
    basicCharactersGroup(),
    { labelKey: 'keycodes.group.editing', keycodes: KEYCODES_BASIC_EDITING, layoutRow: 3 },
    { labelKey: 'keycodes.group.function', keycodes: KEYCODES_BASIC_FUNCTION, layoutRow: 3 },
    { labelKey: 'keycodes.group.modifiers', keycodes: KEYCODES_BASIC_MODS },
  ]
}

/** Group ordering for ISO keyboard view — remaining keycodes below ISO layout */
function getBasicGroupsIso(): KeycodeGroup[] {
  return [
    { labelKey: 'keycodes.group.numpad', keycodes: KEYCODES_BASIC_NUMPAD },
    { labelKey: 'keycodes.group.navigation', keycodes: KEYCODES_BASIC_NAV },
    basicCharactersGroup({ layoutRow: 1 }),
    { labelKey: 'keycodes.group.internal', keycodes: KEYCODES_SPECIAL, layoutRow: 1 },
    { labelKey: 'keycodes.iso', keycodes: KEYCODES_ISO, layoutRow: 1 },
    { labelKey: 'keycodes.group.lock', keycodes: KEYCODES_BASIC_LOCK, layoutRow: 2 },
    { labelKey: 'keycodes.group.system', keycodes: KEYCODES_BASIC_SYSTEM, layoutRow: 2 },
    { labelKey: 'keycodes.group.editing', keycodes: KEYCODES_BASIC_EDITING, layoutRow: 3 },
    { labelKey: 'keycodes.group.function', keycodes: KEYCODES_BASIC_FUNCTION, layoutRow: 3 },
    { labelKey: 'keycodes.group.modifiers', keycodes: KEYCODES_BASIC_MODS },
  ]
}

export const KEYCODE_CATEGORIES: KeycodeCategory[] = [
  {
    id: 'basic',
    labelKey: 'keycodes.basic',
    getKeycodes: () => [...KEYCODES_SPECIAL, ...KEYCODES_BASIC, ...KEYCODES_SHIFTED, ...KEYCODES_ISO],
    getGroups: (viewType?: string) => {
      if (viewType === 'ansi') return getBasicGroupsAnsi()
      if (viewType === 'iso') return getBasicGroupsIso()
      return getBasicGroupsList()
    },
  },
  {
    id: 'layers',
    labelKey: 'keycodes.layers',
    getKeycodes: () => KEYCODES_LAYERS,
    getGroups: () => [
      { labelKey: 'keycodes.group.layerLT', keycodes: KEYCODES_LAYERS_LT, layoutRow: 1 },
      { labelKey: 'keycodes.group.layerLM', keycodes: KEYCODES_LAYERS_LM, layoutRow: 1 },
      { labelKey: 'keycodes.group.layerMO', keycodes: KEYCODES_LAYERS_MO, layoutRow: 2 },
      { labelKey: 'keycodes.group.layerDF', keycodes: KEYCODES_LAYERS_DF, layoutRow: 2 },
      { labelKey: 'keycodes.group.layerPDF', keycodes: KEYCODES_LAYERS_PDF, layoutRow: 3 },
      { labelKey: 'keycodes.group.layerTG', keycodes: KEYCODES_LAYERS_TG, layoutRow: 3 },
      { labelKey: 'keycodes.group.layerTT', keycodes: KEYCODES_LAYERS_TT, layoutRow: 4 },
      { labelKey: 'keycodes.group.layerOSL', keycodes: KEYCODES_LAYERS_OSL, layoutRow: 4 },
      { labelKey: 'keycodes.group.layerTO', keycodes: KEYCODES_LAYERS_TO, layoutRow: 5 },
      { labelKey: 'keycodes.group.layerSpecial', keycodes: KEYCODES_LAYERS_SPECIAL, layoutRow: 5 },
    ],
  },
  {
    id: 'modifiers',
    labelKey: 'keycodes.modifiers',
    getKeycodes: () => KEYCODES_MODIFIERS,
    getGroups: () => [
      {
        labelKey: 'keycodes.group.osm',
        keycodes: KEYCODES_MOD_OSM,
        sections: [KEYCODES_MOD_OSM.slice(0, 15), KEYCODES_MOD_OSM.slice(15)],
      },
      {
        labelKey: 'keycodes.group.modMask',
        keycodes: KEYCODES_MOD_MASK,
        sections: [KEYCODES_MOD_MASK.slice(0, 15), KEYCODES_MOD_MASK.slice(15)],
      },
      {
        labelKey: 'keycodes.group.modTap',
        keycodes: KEYCODES_MOD_TAP,
        sections: [KEYCODES_MOD_TAP.slice(0, 15), KEYCODES_MOD_TAP.slice(15)],
      },
      { labelKey: 'keycodes.group.modSpecial', keycodes: KEYCODES_MOD_SPECIAL },
    ],
  },
  {
    id: 'tapDance',
    labelKey: 'keycodes.tapDance',
    getKeycodes: () => KEYCODES_TAP_DANCE,
  },
  {
    id: 'macro',
    labelKey: 'keycodes.macro',
    getKeycodes: () => KEYCODES_MACRO,
    getGroups: () => [
      { labelKey: 'keycodes.group.macroDM', keycodes: KEYCODES_MACRO_BASE },
    ],
  },
  {
    id: 'quantum',
    labelKey: 'keycodes.quantum',
    getKeycodes: () => [...KEYCODES_QUANTUM, ...KEYCODES_BOOT],
    getGroups: () => [
      { labelKey: 'keycodes.group.boot', keycodes: KEYCODES_BOOT, layoutRow: 1 },
      { labelKey: 'keycodes.group.capsWord', keycodes: KEYCODES_QUANTUM_CAPS_WORD, layoutRow: 1 },
      { labelKey: 'keycodes.group.audio', keycodes: KEYCODES_QUANTUM_AUDIO, layoutRow: 2 },
      { labelKey: 'keycodes.group.haptic', keycodes: KEYCODES_QUANTUM_HAPTIC, layoutRow: 2 },
      { labelKey: 'keycodes.group.magic', keycodes: KEYCODES_QUANTUM_MAGIC },
      { labelKey: 'keycodes.group.autoShift', keycodes: KEYCODES_QUANTUM_AUTOSHIFT, layoutRow: 3 },
      { labelKey: 'keycodes.group.combo', keycodes: KEYCODES_QUANTUM_COMBO, layoutRow: 3 },
      { labelKey: 'keycodes.group.repeat', keycodes: KEYCODES_QUANTUM_REPEAT, layoutRow: 3 },
      { labelKey: 'keycodes.group.keyOverride', keycodes: KEYCODES_QUANTUM_KEY_OVERRIDE, layoutRow: 3 },
      { labelKey: 'keycodes.group.swapHands', keycodes: [...KEYCODES_QUANTUM_SWAP_HANDS, ...KEYCODES_QUANTUM_SWAP_HANDS_TAP] },
    ],
  },
  {
    id: 'media',
    labelKey: 'keycodes.media',
    getKeycodes: () => KEYCODES_MEDIA,
    getGroups: () => [
      { labelKey: 'keycodes.group.mouse', keycodes: KEYCODES_MEDIA_MOUSE },
      { labelKey: 'keycodes.group.joystick', keycodes: KEYCODES_MEDIA_JOYSTICK },
      { labelKey: 'keycodes.group.mediaPlayback', keycodes: KEYCODES_MEDIA_PLAYBACK },
      { labelKey: 'keycodes.group.lockingKeys', keycodes: KEYCODES_MEDIA_LOCK, layoutRow: 1 },
      { labelKey: 'keycodes.group.appBrowser', keycodes: KEYCODES_MEDIA_APP, layoutRow: 1 },
      { labelKey: 'keycodes.group.fKeys', keycodes: KEYCODES_MEDIA_FKEYS, layoutRow: 2 },
      { labelKey: 'keycodes.group.systemControl', keycodes: KEYCODES_MEDIA_SYSTEM, layoutRow: 2 },
    ],
  },
  {
    id: 'midi',
    labelKey: 'keycodes.midi',
    getKeycodes: () => KEYCODES_MIDI,
    getGroups: () => [
      { labelKey: 'keycodes.group.midiNotes', keycodes: KEYCODES_MIDI_BASIC },
      { labelKey: 'keycodes.group.midiOctave', keycodes: KEYCODES_MIDI_OCTAVE, layoutRow: 1 },
      { labelKey: 'keycodes.group.midiTranspose', keycodes: KEYCODES_MIDI_TRANSPOSE, layoutRow: 1 },
      { labelKey: 'keycodes.group.midiVelocity', keycodes: KEYCODES_MIDI_VELOCITY, layoutRow: 2 },
      { labelKey: 'keycodes.group.midiChannel', keycodes: KEYCODES_MIDI_CHANNEL, layoutRow: 2 },
      { labelKey: 'keycodes.group.midiControl', keycodes: KEYCODES_MIDI_CONTROL, layoutRow: 3 },
      { labelKey: 'keycodes.group.sequencer', keycodes: KEYCODES_MIDI_SEQUENCER, layoutRow: 3 },
    ],
  },
  {
    id: 'backlight',
    labelKey: 'keycodes.backlight',
    getKeycodes: () => KEYCODES_BACKLIGHT,
    getGroups: () => [
      { labelKey: 'keycodes.group.rgbMatrix', keycodes: KEYCODES_LIGHTING_MATRIX },
      { labelKey: 'keycodes.group.rgbLighting', keycodes: KEYCODES_LIGHTING_RGB },
      { labelKey: 'keycodes.group.backlight', keycodes: KEYCODES_LIGHTING_BL },
      { labelKey: 'keycodes.group.ledMatrix', keycodes: KEYCODES_LIGHTING_LED_MATRIX },
    ],
  },
  {
    id: 'user',
    labelKey: 'keycodes.user',
    getKeycodes: () => KEYCODES_USER,
  },
]
