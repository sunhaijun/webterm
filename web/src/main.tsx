import { render } from 'preact'

import { Root } from './machines/root'
import { PairPage } from './ui/pair'
import { applyTheme, readTheme } from './ui/prefs'
import '@xterm/xterm/css/xterm.css'
import './style.css'

// Apply the theme before the first render (ADR-0037 §1), on the pairing and gate pages too, so there's no light flash
applyTheme(readTheme())

const root = document.getElementById('app')!
render(
  location.pathname === '/pair' ? <PairPage /> : <Root />,
  root,
)

// The Service Worker caches only the static shell; see public/sw.js.
// It needs a secure context; localhost counts, so it works under --dev too.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
  })
}
