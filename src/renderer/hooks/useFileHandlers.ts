// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { parseLayoutLabels } from '../../shared/layout-options'
import {
  generateAllLayoutOptionsPdf,
  generateCurrentLayoutPdf,
  type LayoutPdfInput,
} from '../../shared/pdf-layout-export'
import type { FileStatus } from '../components/editors/LayoutStoreModal'
import type { KleKey } from '../../shared/kle/types'

interface Options {
  fileIO: {
    loadLayout: () => Promise<boolean>
    saveLayout: () => Promise<boolean>
    exportKeymapC: () => Promise<boolean>
    exportPdf: () => Promise<boolean>
    loading: boolean
    saving: boolean
  }
  layoutLabels: (string | string[])[] | undefined
  layoutKeys: KleKey[] | undefined
  decodedLayoutOptions: Map<number, number>
  deviceName: string
}

export function useFileHandlers(options: Options) {
  const { fileIO, layoutLabels, layoutKeys, decodedLayoutOptions, deviceName } = options
  const { t } = useTranslation()

  const [fileSuccessKind, setFileSuccessKind] = useState<'import' | 'export' | null>(null)

  const showFileSuccess = useCallback((kind: 'import' | 'export') => {
    setFileSuccessKind(kind)
  }, [])

  const clearFileStatus = useCallback(() => {
    setFileSuccessKind(null)
  }, [])

  const handleImportVil = useCallback(async () => {
    const ok = await fileIO.loadLayout()
    if (ok) showFileSuccess('import')
  }, [fileIO.loadLayout, showFileSuccess])

  const handleExportVil = useCallback(async (): Promise<boolean> => {
    const ok = await fileIO.saveLayout()
    return ok
  }, [fileIO.saveLayout])

  const handleExportKeymapC = useCallback(async (): Promise<boolean> => {
    const ok = await fileIO.exportKeymapC()
    return ok
  }, [fileIO.exportKeymapC])

  const handleExportPdf = useCallback(async (): Promise<boolean> => {
    const ok = await fileIO.exportPdf()
    return ok
  }, [fileIO.exportPdf])

  const exportLayoutPdf = useCallback(async (
    generator: (input: LayoutPdfInput) => string,
    suffix: string,
  ) => {
    try {
      const parsedOptions = parseLayoutLabels(layoutLabels)
      const base64 = generator({
        deviceName,
        keys: (layoutKeys ?? []) as LayoutPdfInput['keys'],
        layoutOptions: parsedOptions,
        currentValues: decodedLayoutOptions,
      })
      await window.vialAPI.exportPdf(base64, `${deviceName}_layout_${suffix}`)
    } catch {
      // Export errors are non-critical
    }
  }, [layoutLabels, layoutKeys, decodedLayoutOptions, deviceName])

  const handleExportLayoutPdfAll = useCallback(
    () => exportLayoutPdf(generateAllLayoutOptionsPdf, 'all'),
    [exportLayoutPdf],
  )

  const handleExportLayoutPdfCurrent = useCallback(
    () => exportLayoutPdf(generateCurrentLayoutPdf, 'current'),
    [exportLayoutPdf],
  )

  const fileStatus: FileStatus = useMemo(() => {
    if (fileIO.loading) return 'importing'
    if (fileSuccessKind === 'import') return { kind: 'success', message: t('fileIO.importSuccess') }
    // Export status is shown inline on the .vil/.c/.pdf button row, not as fileStatus
    return 'idle'
  }, [fileIO.loading, fileIO.saving, fileSuccessKind, t])

  return {
    fileSuccessKind,
    fileStatus,
    clearFileStatus,
    handleImportVil,
    handleExportVil,
    handleExportKeymapC,
    handleExportPdf,
    handleExportLayoutPdfAll,
    handleExportLayoutPdfCurrent,
  }
}
