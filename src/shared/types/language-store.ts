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
