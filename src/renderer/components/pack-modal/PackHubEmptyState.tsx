// SPDX-License-Identifier: GPL-2.0-or-later

import { Trans } from 'react-i18next'
import { buildHubCategoryUrl, type HubCategory } from '../../../shared/hub-urls'

export interface PackHubEmptyStateProps {
  /** i18n/theme render a `<p>`; Key Labels renders a `<div>`. */
  as?: 'p' | 'div'
  className: string
  /** i18n/theme tag the wrapper with a testid; Key Labels does not. */
  testid?: string
  hubSearched: boolean
  emptyText: string
  hubOrigin: string
  category: HubCategory
  initialLinkTestid: string
}

/**
 * "No results yet" / "Find packs on Hub" hint shown on the Hub tab
 * before a search has run, or the localized empty-results message once
 * a search comes back with zero items. Structurally identical across
 * the three pack modals modulo wrapper tag/class/testid.
 */
export function PackHubEmptyState({
  as = 'p',
  className,
  testid,
  hubSearched,
  emptyText,
  hubOrigin,
  category,
  initialLinkTestid,
}: PackHubEmptyStateProps): JSX.Element {
  const Tag = as
  return (
    <Tag className={className} data-testid={testid}>
      {hubSearched ? (
        emptyText
      ) : (
        <Trans
          i18nKey="common.findOnHubHint"
          components={{
            hub: hubOrigin ? (
              <a
                href={buildHubCategoryUrl(hubOrigin, category)}
                onClick={(e) => {
                  e.preventDefault()
                  void window.vialAPI.openExternal(buildHubCategoryUrl(hubOrigin, category))
                }}
                className="text-accent hover:underline"
                data-testid={initialLinkTestid}
              />
            ) : (
              <span />
            ),
          }}
        />
      )}
    </Tag>
  )
}
