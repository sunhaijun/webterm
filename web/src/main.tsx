import { render } from 'preact'

import { App } from './app/app'
import { Gate } from './ui/gate'
import { PairPage } from './ui/pair'
import '@xterm/xterm/css/xterm.css'
import './style.css'

const root = document.getElementById('app')!
render(
  location.pathname === '/pair' ? (
    <PairPage />
  ) : (
    <Gate>{(revoke) => <App onRevoked={revoke} />}</Gate>
  ),
  root,
)

// Service Worker 只缓存静态壳，见 public/sw.js。
// 需要 secure context —— localhost 也算，所以 --dev 下同样能测。
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
  })
}
