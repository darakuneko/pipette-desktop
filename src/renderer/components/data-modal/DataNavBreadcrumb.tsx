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

  return (
    <nav className="text-xs text-content-muted" data-testid="data-nav-breadcrumb">
      {segments.map((seg, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-1">&rsaquo;</span>}
          {seg}
        </span>
      ))}
    </nav>
  )
}
