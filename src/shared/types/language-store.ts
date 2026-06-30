export interface LanguageManifestEntry {
  name: string
  wordCount: number
  rightToLeft: boolean
  fileSize: number
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
  languages: LanguageManifestEntry[]
}

/** Bundled default dataset for a provider, shipped with the app and used
 *  until/unless the Hub provides a newer version. Extends the wire dataset
 *  with the set of languages baked into the app bundle (never downloaded). */
export interface TypingTestProviderDefault extends TypingTestDataset {
  bundledLanguages: string[]
}
