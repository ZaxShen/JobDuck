import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { FlashProvider } from '@/hooks/use-flash'
import { App } from '@/App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      <FlashProvider>
        <App />
      </FlashProvider>
    </CSPProvider>
  </StrictMode>,
)
