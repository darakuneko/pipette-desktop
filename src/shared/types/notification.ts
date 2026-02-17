export interface AppNotification {
  title: string
  body: string
  type: string
  publishedAt: string // ISO 8601
}

export interface NotificationFetchResult {
  success: boolean
  notifications?: AppNotification[]
  error?: string
}
