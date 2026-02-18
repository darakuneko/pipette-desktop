// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import appIcon from '../assets/app-icon.png'
import { LEGAL_SECTIONS } from './legal-content'

export function AboutTabContent() {
  const { t } = useTranslation()

  return (
    <div className="pt-4 space-y-6">
      <div className="flex flex-col items-center gap-3">
        <img
          src={appIcon}
          alt="Pipette"
          width={64}
          height={64}
          data-testid="about-app-icon"
        />
        <h3
          className="text-lg font-bold text-content"
          data-testid="about-app-name"
        >
          Pipette
        </h3>
        <span
          className="text-sm text-content-muted"
          data-testid="about-app-version"
        >
          {t('settings.about.version', { version: __APP_VERSION__ })}
        </span>
        <span
          className="text-sm text-content-muted"
          data-testid="about-license"
        >
          {t('settings.about.license', { license: t('settings.about.licenseValue') })}
        </span>
      </div>

      <div
        className="max-h-60 overflow-y-auto rounded-lg border border-edge bg-surface p-4 space-y-4"
        data-testid="about-legal-content"
      >
        {LEGAL_SECTIONS.map((section) => (
          <div key={section.title} className="space-y-2">
            <h5 className="text-sm font-medium text-content">{section.title}</h5>
            {section.paragraphs.map((paragraph, i) => (
              <p key={i} className="text-xs text-content-muted leading-relaxed">
                {paragraph}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
