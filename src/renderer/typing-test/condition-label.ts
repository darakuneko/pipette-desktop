// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult } from '../../shared/types/pipette-settings'

/** Compact "+punct +nums" suffix for the words/time toggles, omitted
 *  entirely when neither is set. */
function toggleSuffix(result: TypingTestResult, t: (key: string) => string): string {
  const parts: string[] = []
  if (result.punctuation) parts.push(t('editor.typingTest.history.conditionPunctuation'))
  if (result.numbers) parts.push(t('editor.typingTest.history.conditionNumbers'))
  if (result.romajiInput) parts.push(t('editor.typingTest.history.conditionRomaji'))
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

/** Human-readable label for a result's test condition, shown in the
 *  Accuracy Trend condition selector (e.g. "50 words (english) +punct
 *  +nums", "30s (english)", "medium quote (english)", an imported
 *  text's name, or "Tatoeba (japanese)"). Built entirely from fields
 *  already stored on the result, so it renders for legacy rows too. */
export function formatConditionLabel(result: TypingTestResult, t: (key: string) => string): string {
  const mode = result.mode ?? 'words'
  const language = result.language ?? ''
  switch (mode) {
    case 'words':
      return `${String(result.mode2 ?? '')} ${t('editor.typingTest.mode.words')} (${language})${toggleSuffix(result, t)}`
    case 'time':
      return `${String(result.mode2 ?? '')}s (${language})${toggleSuffix(result, t)}`
    case 'quote': {
      const lengthLabel = t(`editor.typingTest.quoteLength.${String(result.mode2 ?? '')}`)
      return `${lengthLabel} ${t('editor.typingTest.mode.quote')} (${language})`
    }
    case 'fileImport':
      // Text name takes priority; falls back to the stable textId for
      // legacy rows saved before the name was captured.
      return result.fileImportTextName || String(result.mode2 ?? '')
    case 'tatoeba':
      return `${t('editor.typingTest.history.conditionTatoeba')} (${String(result.mode2 ?? language)})`
  }
}
