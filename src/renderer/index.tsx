import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import './style.css'
import i18n from './i18n'
import { App } from './App'
import { AppConfigProvider } from './hooks/useAppConfig'
import { UploadConfirmProvider } from './hooks/useUploadConfirm'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <AppConfigProvider>
          <UploadConfirmProvider>
            <App />
          </UploadConfirmProvider>
        </AppConfigProvider>
      </I18nextProvider>
    </StrictMode>,
  )
}
