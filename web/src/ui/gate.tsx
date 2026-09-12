/**
 * 认证闸门：未配对时展示引导页而不是空白。
 *
 * 静态资源本身不认证（JS/CSS 里没有秘密），所以判断放在前端：
 * 调 /api/devices 拿到 401 就说明这台设备还没配对。
 */
import { useEffect, useState } from 'preact/hooks'

import { App } from './app'

type Gate = 'checking' | 'authed' | 'unpaired' | 'offline'

export function Root() {
  const [gate, setGate] = useState<Gate>('checking')

  useEffect(() => {
    fetch('/api/devices', { credentials: 'same-origin' })
      .then((r) => setGate(r.status === 401 ? 'unpaired' : 'authed'))
      .catch(() => setGate('offline'))
  }, [])

  if (gate === 'checking') return <main class="gate">正在检查配对状态…</main>
  if (gate === 'authed') return <App />
  if (gate === 'offline') {
    // 离线时明确说无法连接，不假装能用
    return (
      <main class="gate" data-testid="offline">
        <h1>无法连接到 agent</h1>
        <p>检查网络，或确认 webterm 还在运行。</p>
      </main>
    )
  }
  return (
    <main class="gate" data-testid="unpaired">
      <h1>需要配对</h1>
      <p>这台设备还没有获得授权。在服务器上执行：</p>
      <pre>webterm pair</pre>
      <p>
        然后用这台设备扫描终端里打印的二维码；扫不了码就<a href="/pair">打开配对页</a>，输入终端里那 16 位数字。
      </p>
    </main>
  )
}
