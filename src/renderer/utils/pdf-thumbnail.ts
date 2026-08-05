// SPDX-License-Identifier: GPL-2.0-or-later

// Vite resolves ?url to a static asset URL (not the file content)
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

let workerConfigured = false

/** Render the first page of a PDF (base64) to a JPEG thumbnail (base64). */
export async function generatePdfThumbnail(pdfBase64: string): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist')
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc
    workerConfigured = true
  }

  const raw = atob(pdfBase64)
  const data = Uint8Array.from(raw, (ch) => ch.charCodeAt(0))

  // pdfjs-dist 6 dropped PDFDocumentProxy.destroy() — only the loading task
  // (the object getDocument() returns before its promise resolves) still
  // exposes destroy(), so the reference has to be kept separately from the
  // resolved document.
  const loadingTask = pdfjsLib.getDocument({ data })
  const doc = await loadingTask.promise
  try {
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1.0 })

    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')

    await page.render({ canvas, canvasContext: ctx, viewport }).promise

    const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
    return dataUrl.replace(/^data:image\/jpeg;base64,/, '')
  } finally {
    await loadingTask.destroy()
  }
}
