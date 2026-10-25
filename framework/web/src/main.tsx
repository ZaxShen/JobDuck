import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { applyThemeClass, readStoredTheme, ThemeProvider } from '@/components/theme-provider'
import { FlashProvider } from '@/hooks/use-flash'
import { App } from '@/App'
import './index.css'

applyThemeClass(readStoredTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      <ThemeProvider>
        <FlashProvider>
          <App />
        </FlashProvider>
      </ThemeProvider>
    </CSPProvider>
  </StrictMode>,
)
