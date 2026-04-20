// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import type { DataNavPath } from './data-modal-types'
import { breadcrumbSegments } from './data-modal-types'

interface Props {
  path: DataNavPath
}

export function DataNavBreadcrumb({ path }: Props) {
  const { t } = useTranslation()
  const segments = breadcrumbSegments(path, t)
  // Every path variant that scopes to a single keyboard carries `uid`.
  // Surfacing it beside the breadcrumb lets advanced users cross-check
  // the keyboard without taking screen space from the main content.
  const uid = 'uid' in path ? path.uid : undefined

  return (
    <nav className="flex items-center justify-between gap-2 text-xs text-content-muted" data-testid="data-nav-breadcrumb">
      <div className="min-w-0">
        {segments.map((seg, i) => (
          <span key={i}>
            {i > 0 && <span className="mx-1">&rsaquo;</span>}
            {seg}
          </span>
        ))}
      </div>
      {uid && <span className="shrink-0 font-mono text-[11px]">{uid}</span>}
    </nav>
  )
}
