// SPDX-License-Identifier: GPL-2.0-or-later
// Content-Security-Policy builder and security response headers

const BASE_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
]

export function buildCsp(isDev: boolean): string {
  const inline = isDev ? " 'unsafe-inline'" : ''
  const wsConnect = isDev ? ' ws://localhost:*' : ''

  const directives = [
    ...BASE_DIRECTIVES,
    `script-src 'self'${inline}`,
    `style-src 'self'${inline}`,
    `connect-src 'self'${wsConnect}`,
  ]
  return directives.join('; ')
}

export const securityHeaders: Record<string, string[]> = {
  'X-Content-Type-Options': ['nosniff'],
  'X-Frame-Options': ['DENY'],
}
