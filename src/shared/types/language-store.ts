export interface LanguageManifestEntry {
  name: string
  wordCount: number
  rightToLeft: boolean
  fileSize: number
  /** Work title. Present for catalog providers (aozora); used by the
   *  desktop's catalog picker UI. Absent for pack providers. */
  title?: string
  /** Work author. Present for catalog providers (aozora); used by the
   *  desktop's catalog picker UI. Absent for pack providers. */
  author?: string
  /** Lead author's reading, used for the gojuon (五十音) filter in the
   *  desktop's catalog picker UI. Hiragana for Japanese authors, katakana
   *  for foreign authors. Present for catalog providers (aozora) only;
   *  older cached overrides predating this field may still lack it. */
  authorKana?: string
}

export type LanguageDownloadStatus = 'bundled' | 'downloaded' | 'not-downloaded'

export interface LanguageListEntry extends LanguageManifestEntry {
  status: LanguageDownloadStatus
}

/** A typing-test word dataset for one provider. Matches the Hub
 *  `GET /api/typing-test/datasets/:provider` response shape so a Hub
 *  payload can be persisted as an override verbatim. `version` is an
 *  opaque snapshot id (the upstream commit hash for monkeytype). */
export interface TypingTestDataset {
  provider: string
  version: string
  /** Base URL for per-language word files: `<downloadUrlBase>/<name>.json`. */
  downloadUrlBase: string
  /** Wire-level discriminator: 'pack' = interchangeable word/sentence
   *  entries meant to be sampled (monkeytype, tatoeba); 'catalog' = each
   *  entry is one whole work to individually download (aozora). Optional
   *  and absent means 'pack' — overrides persisted before this field
   *  existed never carried it, so treating a missing value as 'pack' keeps
   *  them valid without a migration. Also implies how to read `wordCount`
   *  on each entry: exact for 'pack', an estimate for 'catalog' (the Hub
   *  never downloads/cleans a catalog work, so it can't know the exact
   *  post-cleaning length). */
  model?: 'pack' | 'catalog'
  languages: LanguageManifestEntry[]
}

/** Bundled default dataset for a provider, shipped with the app and used
 *  until/unless the Hub provides a newer version. Extends the wire dataset
 *  with the set of languages baked into the app bundle (never downloaded). */
export interface TypingTestProviderDefault extends TypingTestDataset {
  bundledLanguages: string[]
}
