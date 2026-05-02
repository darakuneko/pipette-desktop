// SPDX-License-Identifier: GPL-2.0-or-later
// Shared types for Pipette Hub /api/key-labels endpoints.

export interface HubKeyLabelItem {
  /** Hub post id (UUID, used in DELETE/PUT/download URLs). */
  id: string
  name: string
  map: Record<string, string>
  composite_labels: Record<string, string> | null
  uploaded_by: string | null
  uploader_name: string | null
  created_at: string
  updated_at: string
}

export interface HubKeyLabelListResponse {
  items: HubKeyLabelItem[]
  total: number
  page: number
  per_page: number
}

export interface HubKeyLabelListParams {
  q?: string
  page?: number
  perPage?: number
}

/** Sentinel error returned from upload/update when Hub responds with 409 (name conflict). */
export const HUB_ERROR_KEY_LABEL_DUPLICATE = 'KEY_LABEL_DUPLICATE'
