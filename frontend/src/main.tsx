import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Шрифты — из npm, не с CDN (design/README.md): без сети макет не разваливается.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import './tokens.css'
import './app.css'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
