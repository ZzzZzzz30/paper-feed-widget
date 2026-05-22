import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

window.addEventListener('error', (e) => console.error('[Renderer error]', e.error || e.message))
window.addEventListener('unhandledrejection', (e) => console.error('[Renderer unhandledrejection]', e.reason))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
