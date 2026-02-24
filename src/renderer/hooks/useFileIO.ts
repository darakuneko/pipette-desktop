// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VilFile } from '../../shared/types/protocol'
import { isVilFile } from '../../shared/vil-file'
import { isVialGuiFile, vialGuiToVil } from '../../shared/vil-compat'
import { serializeMacro, jsonToMacroActions } from '../../preload/macro'

export interface UseFileIOOptions {
  deviceUid: string
  deviceName: string
  serialize: () => VilFile
  serializeVialGui?: () => string
  applyVilFile: (vil: VilFile) => Promise<void>
  keymapCGenerator?: () => string
  pdfGenerator?: () => string
}

export function useFileIO({
  deviceUid,
  deviceName,
  serialize,
  serializeVialGui,
  applyVilFile,
  keymapCGenerator,
  pdfGenerator,
}: UseFileIOOptions) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  // Shared wrapper for export operations that follow the same
  // generate-content -> call-IPC -> handle-result pattern
  async function runExport(
    generate: () => string,
    send: (content: string, name: string) => Promise<{ success: boolean; error?: string }>,
    errorKey: string,
  ): Promise<boolean> {
    setError(null)
    setSaving(true)
    try {
      const content = generate()
      const result = await send(content, deviceName)
      if (!result.success) {
        if (result.error !== 'cancelled') {
          setError(t(errorKey))
        }
        return false
      }
      return true
    } catch {
      setError(t(errorKey))
      return false
    } finally {
      setSaving(false)
    }
  }

  const saveLayout = useCallback(
    () => runExport(
      () => serializeVialGui ? serializeVialGui() : JSON.stringify(serialize(), null, 2),
      window.vialAPI.saveLayout,
      'error.saveFailed',
    ),
    [serialize, serializeVialGui, deviceName, t],
  )

  const loadLayout = useCallback(async (): Promise<boolean> => {
    setError(null)
    setLoading(true)
    try {
      const result = await window.vialAPI.loadLayout(t('fileIO.loadLayout'))
      if (!result.success) {
        if (result.error !== 'cancelled') {
          setError(t('error.loadFailed'))
        }
        return false
      }

      const rawJson = result.data!
      const parsed: unknown = JSON.parse(rawJson)

      let vil: VilFile
      if (isVilFile(parsed)) {
        // Pipette native format
        vil = parsed
      } else if (isVialGuiFile(parsed)) {
        // vial-gui format: convert macros and build VilFile
        const data = parsed as Record<string, unknown>
        const vialProtocol = (data.vial_protocol as number) ?? 6
        const macroJsonArrays = (data.macro as unknown[][]) ?? []
        const macroBuffer = convertVialGuiMacros(macroJsonArrays, vialProtocol)
        vil = vialGuiToVil(data, rawJson, macroBuffer)
        vil.macroJson = macroJsonArrays
      } else {
        setError(t('error.loadFailed'))
        return false
      }

      // UID mismatch check — compare as BigInt to ignore hex case/padding differences
      if (deviceUid !== '0x0' && BigInt(vil.uid) !== BigInt(deviceUid)) {
        const confirmed = window.confirm(t('fileIO.uidMismatchConfirm'))
        if (!confirmed) {
          return false
        }
      }

      await applyVilFile(vil)
      return true
    } catch {
      setError(t('error.loadFailed'))
      return false
    } finally {
      setLoading(false)
    }
  }, [deviceUid, applyVilFile, t])

  const exportKeymapC = useCallback((): Promise<boolean> => {
    if (!keymapCGenerator) return Promise.resolve(false)
    return runExport(keymapCGenerator, window.vialAPI.exportKeymapC, 'error.exportKeymapCFailed')
  }, [keymapCGenerator, deviceName, t])

  const exportPdf = useCallback((): Promise<boolean> => {
    if (!pdfGenerator) return Promise.resolve(false)
    return runExport(pdfGenerator, window.vialAPI.exportPdf, 'error.exportPdfFailed')
  }, [pdfGenerator, deviceName, t])

  return { saveLayout, loadLayout, exportKeymapC, exportPdf, error, saving, loading }
}

function convertVialGuiMacros(macroJsonArrays: unknown[][], vialProtocol: number): number[] {
  const buffer: number[] = []
  for (const macroJson of macroJsonArrays) {
    const json = JSON.stringify(macroJson)
    const actions = jsonToMacroActions(json)
    if (actions) {
      buffer.push(...serializeMacro(actions, vialProtocol))
    }
    buffer.push(0) // NUL terminator
  }
  return buffer
}
