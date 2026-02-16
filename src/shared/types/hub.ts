// SPDX-License-Identifier: GPL-2.0-or-later
// Shared types for Hub upload operations

export interface HubUploadPostParams {
  title: string
  keyboardName: string
  vilJson: string
  pippetteJson: string
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
  title?: string
}

export interface HubDeleteResult {
  success: boolean
  error?: string
}

export interface HubMyPost {
  id: string
  title: string
}

export interface HubFetchMyPostsResult {
  success: boolean
  posts?: HubMyPost[]
  error?: string
}
