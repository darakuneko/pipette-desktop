// SPDX-License-Identifier: GPL-2.0-or-later
// Shared types for Hub upload operations

export interface HubUploadPostParams {
  title: string
  keyboardName: string
  vilJson: string
  keymapC: string
  pdfBase64: string
  thumbnailBase64: string
}

export interface HubUploadResult {
  success: boolean
  postId?: string
  error?: string
}

export interface HubUpdatePostParams extends HubUploadPostParams {
  postId: string
}

export interface HubPatchPostParams {
  postId: string
  title: string
}

export interface HubDeleteResult {
  success: boolean
  error?: string
}

export interface HubPostFile {
  file_type: string
  original_filename: string
  file_size: number
}

export interface HubMyPost {
  id: string
  title: string
  keyboard_name: string
  description?: string | null
  created_at: string
  updated_at?: string
  uploaded_by?: string
  uploader_name?: string
  download_count?: number
  files?: HubPostFile[]
}

export interface HubPaginationMeta {
  total: number
  page: number
  per_page: number
  total_pages: number
}

export interface HubFetchMyPostsParams {
  page?: number
  per_page?: number
}

export interface HubFetchMyPostsResult {
  success: boolean
  posts?: HubMyPost[]
  pagination?: HubPaginationMeta
  error?: string
}

export type HubFetchMyKeyboardPostsResult = HubFetchMyPostsResult

export interface HubUser {
  id: string
  email: string
  display_name: string | null
  role: string
}

export const HUB_ERROR_DISPLAY_NAME_CONFLICT = 'DISPLAY_NAME_CONFLICT'
export const HUB_ERROR_ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED'
export const HUB_ERROR_RATE_LIMITED = 'RATE_LIMITED'

export interface HubUserResult {
  success: boolean
  user?: HubUser
  error?: string
}

export type HubFeaturePostType = 'td' | 'macro' | 'combo' | 'ko' | 'ark'

export interface HubUploadFavoritePostParams {
  type: string // FavoriteType
  entryId: string
  title: string
}

export interface HubUpdateFavoritePostParams extends HubUploadFavoritePostParams {
  postId: string
}
