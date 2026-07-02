// SPDX-License-Identifier: GPL-2.0-or-later
//
// Downloads one Aozora Bunko catalog work (a Shift_JIS-encoded ZIP,
// referenced by the manifest's `name` — a path relative to the dataset's
// `downloadUrlBase`), unzips it, decodes and cleans the text, and saves the
// result into the local Typing Test text store (fileImport model, verbatim
// paragraph structure). Unlike LANG_DOWNLOAD (pack model, one JSON file per
// language), a catalog work is a whole ZIP archive that needs unpacking and
// Shift_JIS decoding before it can be used.
//
// Only manifest-listed names are ever fetched: importAozoraWork() looks the
// workId up in the effective aozora dataset first and fails closed
// (NOT_IN_CATALOG) if it is not present, so this never turns into an
// open URL-fetch proxy.

import { unzipSync } from 'fflate'
import { fetchVerifiedBytes } from '../download-util'
import { getEffectiveDataset } from '../language-store'
import { saveRecord } from '../typing-test-text-store'
import { cleanAozoraText } from './aozora-clean'
import { log } from '../logger'
import type { AozoraImportErrorCode, AozoraImportResult } from '../../shared/types/aozora-import'

const AOZORA_PROVIDER = 'aozora'

// Above this share of U+FFFD (Unicode replacement character) in the decoded
// text, the Shift_JIS decode is treated as having failed outright rather
// than as carrying a few unmappable characters — a typing test cannot make
// progress through a run of replacement characters.
const FFFD_RATIO_THRESHOLD = 0.005

function fail(errorCode: AozoraImportErrorCode, error: string): AozoraImportResult {
  return { success: false, errorCode, error }
}

/** Picks the ZIP entry to decode: the largest file whose path ends in an
 *  ASCII `.txt` (case-insensitive), skipping directories and macOS resource
 *  fork noise. Aozora ZIPs sometimes carry a Shift_JIS-encoded filename that
 *  arrives here mojibake'd (fflate doesn't re-decode zip filenames as
 *  Shift_JIS), but the `.txt` suffix itself is always plain ASCII, so the
 *  match is robust regardless of how the rest of the name decoded. */
function pickTextEntry(unzipped: Record<string, Uint8Array>): Uint8Array | null {
  let best: Uint8Array | null = null
  for (const [path, data] of Object.entries(unzipped)) {
    if (path.includes('__MACOSX')) continue
    if (!/\.txt$/i.test(path)) continue
    if (!best || data.byteLength > best.byteLength) best = data
  }
  return best
}

/** Imports one Aozora Bunko work by its catalog `name` (== workId, the
 *  manifest's relative ZIP path) into the local Typing Test text store. */
export async function importAozoraWork(workId: string): Promise<AozoraImportResult> {
  const dataset = await getEffectiveDataset(AOZORA_PROVIDER)
  if (dataset.model !== 'catalog') {
    return fail('NOT_IN_CATALOG', `Aozora dataset is not catalog-shaped (model: ${String(dataset.model)})`)
  }
  const entry = dataset.languages.find((e) => e.name === workId)
  if (!entry) {
    return fail('NOT_IN_CATALOG', `Aozora work not in catalog: ${workId}`)
  }

  const fetched = await fetchVerifiedBytes(`${dataset.downloadUrlBase}/${workId}`, entry.fileSize)
  if (!fetched.ok) {
    if (fetched.reason === 'size-mismatch') {
      const detail = `expected ${String(fetched.expected)} bytes, got ${String(fetched.actual)}`
      log('warn', `Aozora work ${workId}: size mismatch (${detail})`)
      return fail('SIZE_MISMATCH', detail)
    }
    const detail = fetched.reason === 'http' ? `HTTP ${String(fetched.status)}` : String(fetched.error)
    log('warn', `Aozora download failed for ${workId}: ${detail}`)
    return fail('DOWNLOAD_FAILED', detail)
  }
  const bytes = fetched.bytes

  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(bytes)
  } catch (err) {
    return fail('NO_TEXT_ENTRY', `Failed to unzip: ${String(err)}`)
  }

  const textBytes = pickTextEntry(unzipped)
  if (!textBytes) {
    return fail('NO_TEXT_ENTRY', 'Zip contains no .txt entry')
  }

  const decoded = new TextDecoder('shift_jis').decode(textBytes)
  const fffdCount = (decoded.match(/�/g) ?? []).length
  if (decoded.length > 0 && fffdCount / decoded.length > FFFD_RATIO_THRESHOLD) {
    return fail('DECODE_FAILED', 'Decoded text exceeds the replacement-character threshold')
  }

  const cleaned = cleanAozoraText(decoded)
  if (!cleaned.trim()) {
    return fail('EMPTY_TEXT', 'Cleaned text is empty')
  }

  const name = entry.title ? `${entry.title}（${entry.author ?? ''}）` : workId
  const result = await saveRecord({ name, text: cleaned, source: { provider: AOZORA_PROVIDER, workId } })
  if (!result.success || !result.data) {
    return fail(result.errorCode ?? 'IO_ERROR', result.error ?? 'Failed to save text')
  }

  log('info', `Imported Aozora work: ${workId} -> ${result.data.id}`)
  return { success: true, meta: result.data }
}
