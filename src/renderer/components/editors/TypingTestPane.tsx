// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { TypingTestView } from '../../typing-test/TypingTestView'
import { LanguageSelectorModal } from '../../typing-test/LanguageSelectorModal'
import { HistoryToggle } from './HistoryToggle'
import { KeyboardPane } from './KeyboardPane'
import type { KleKey } from '../../../shared/kle/types'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { TypingTestConfig } from '../../typing-test/types'
import type { useTypingTest } from '../../typing-test/useTypingTest'

export interface TypingTestPaneProps {
  typingTest: ReturnType<typeof useTypingTest>
  onConfigChange: (config: TypingTestConfig) => void
  onLanguageChange: (lang: string) => Promise<void>
  layers: number
  layerNames?: string[]
  typingTestHistory?: TypingTestResult[]
  deviceName?: string
  pressedKeys: Set<string>
  keycodes: Map<string, string>
  encoderKeycodes: Map<string, [string, string]>
  remappedKeys: Set<string>
  layoutOptions: Map<number, number>
  scale: number
  keys: KleKey[]
  layerLabel: string
  contentRef?: React.RefObject<HTMLDivElement | null>
}

export function TypingTestPane({
  typingTest,
  onConfigChange,
  onLanguageChange,
  layers,
  layerNames,
  typingTestHistory,
  deviceName,
  pressedKeys,
  keycodes,
  encoderKeycodes,
  remappedKeys,
  layoutOptions,
  scale,
  keys,
  layerLabel,
  contentRef,
}: TypingTestPaneProps) {
  const { t } = useTranslation()
  const [showLanguageModal, setShowLanguageModal] = useState(false)

  return (
    <>
      <TypingTestView
        state={typingTest.state}
        wpm={typingTest.wpm}
        accuracy={typingTest.accuracy}
        elapsedSeconds={typingTest.elapsedSeconds}
        remainingSeconds={typingTest.remainingSeconds}
        config={typingTest.config}
        paused={typingTest.state.status === 'running' && !typingTest.windowFocused}
        onRestart={typingTest.restart}
        onConfigChange={onConfigChange}
        onCompositionStart={typingTest.processCompositionStart}
        onCompositionUpdate={typingTest.processCompositionUpdate}
        onCompositionEnd={typingTest.processCompositionEnd}
        onImeSpaceKey={() => typingTest.processKeyEvent(' ', false, false, false)}
      />
      <div className="flex items-start justify-center overflow-auto">
        <div>
          <div className="mb-3 flex items-center justify-between px-5">
            <div className="flex items-center gap-4">
              {layers > 1 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-content-muted">{t('editor.typingTest.baseLayer')}:</span>
                  <select
                    data-testid="base-layer-select"
                    aria-label={t('editor.typingTest.baseLayer')}
                    value={typingTest.baseLayer}
                    onChange={(e) => typingTest.setBaseLayer(Number(e.target.value))}
                    className="rounded-md border border-edge bg-surface-alt px-2 py-1 text-sm text-content-secondary"
                  >
                    {Array.from({ length: layers }, (_, i) => (
                      <option key={i} value={i}>{layerNames?.[i] || i}</option>
                    ))}
                  </select>
                </div>
              )}
              {typingTest.config.mode !== 'quote' && (
                <button
                  type="button"
                  data-testid="language-selector"
                  className="flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-sm text-content-secondary transition-colors hover:text-content"
                  onClick={() => setShowLanguageModal(true)}
                  disabled={typingTest.isLanguageLoading}
                >
                  {typingTest.isLanguageLoading ? (
                    <span>{t('editor.typingTest.language.loadingLanguage')}</span>
                  ) : (
                    <>
                      <Globe size={14} aria-hidden="true" />
                      <span>{typingTest.language.replace(/_/g, ' ')}</span>
                    </>
                  )}
                </button>
              )}
              {showLanguageModal && (
                <LanguageSelectorModal
                  currentLanguage={typingTest.language}
                  onSelectLanguage={onLanguageChange}
                  onClose={() => setShowLanguageModal(false)}
                />
              )}
            </div>
            {typingTestHistory && typingTestHistory.length > 0 && (
              <HistoryToggle results={typingTestHistory} deviceName={deviceName} />
            )}
          </div>
          <KeyboardPane
            paneId="primary"
            isActive={false}
            isSplitEdit={false}
            keys={keys}
            keycodes={keycodes}
            encoderKeycodes={encoderKeycodes}
            selectedKey={null}
            selectedEncoder={null}
            selectedMaskPart={false}
            selectedKeycode={null}
            pressedKeys={pressedKeys}
            everPressedKeys={undefined}
            remappedKeys={remappedKeys}
            layoutOptions={layoutOptions}
            scale={scale}
            layerLabel={layerLabel}
            layerLabelTestId="layer-label"
            contentRef={contentRef}
          />
        </div>
      </div>
      <p data-testid="typing-test-layer-note" className="text-center text-xs text-content-muted">
        {t('editor.typingTest.layerNote')}
      </p>
    </>
  )
}
