import { render } from 'preact'

import { PairPage } from './ui/pair'
import { Root } from './ui/gate'
import './style.css'
import '@xterm/xterm/css/xterm.css'

const root = document.getElementById('app')!
render(location.pathname === '/pair' ? <PairPage /> : <Root />, root)
