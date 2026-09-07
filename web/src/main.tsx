import { render } from 'preact'

import { PairPage } from './ui/pair'
import { Root } from './ui/gate'
import './style.css'
import '@xterm/xterm/css/xterm.css'

const root = document.getElementById('app')!
render(location.pathname === '/pair' ? <PairPage /> : <Root />, root)

// Service Worker 只缓存静态壳，见 public/sw.js。
// 需要 secure context —— localhost 也算，所以 --dev 下同样能测。
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
  })
}
