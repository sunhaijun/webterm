/**
 * E2E 夹具：起真二进制、完成配对、给出操作终端的把手。
 *
 * 见 docs/70-testing/e2e-scenarios.md 的「测试夹具」。界面是 ADR-0025 的 Termux 式：
 * 没有输入模式、没有 Composer —— 敲命令就是点终端打字。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, type Page } from '@playwright/test'

/** 让内核挑一个空闲端口。随机猜端口在并行/连跑时会撞车。 */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) {
        const p = addr.port
        srv.close(() => res(p))
      } else {
        srv.close(() => rej(new Error('拿不到端口')))
      }
    })
  })
}

const REPO = resolve(process.cwd(), '..')
const BINARY = join(REPO, 'webterm')

/** 夹具脚本目录（绝对路径：会话默认起在 $HOME，不 cd 过去也能跑）。 */
export const FIXTURES = resolve(process.cwd(), 'e2e/fixtures')
/** `emit.sh <行数> [每行延迟ms]` —— 确定性输出，字节级比较用。 */
export const EMIT = `bash ${FIXTURES}/emit.sh`
/** `altscreen.sh <快跑秒数> <完成标记文件>` —— 假的全屏 TUI（E2E-31 / E2E-36）。 */
export const ALTSCREEN = `bash ${FIXTURES}/altscreen.sh`

export interface AgentOptions {
  /**
   * 每会话环形缓冲。默认用 agent 自己的默认值（256 KiB）—— 断线窗口内的输出不会溢出，
   * 增量路径的字节级比较才稳定。只有快照路径的场景（E2E-2c / 4 / 30 / 31）调成 65536。
   */
  ringBytes?: number
  maxSessions?: number
  /** 追加的 serve 参数（排障用，如 `--log-level debug`）。 */
  extraArgs?: string[]
}

export class Agent {
  readonly baseURL: string
  private proc: ChildProcess
  private readonly dataDir: string
  private readonly opts: AgentOptions
  private pairURL = ''
  private pairUsed = false
  private log = ''

  private readonly port: number

  private constructor(proc: ChildProcess, port: number, dataDir: string, opts: AgentOptions) {
    this.proc = proc
    this.port = port
    this.baseURL = `http://127.0.0.1:${port}`
    this.dataDir = dataDir
    this.opts = opts
  }

  private static args(port: number, dataDir: string, opts: AgentOptions): string[] {
    const args = ['serve', '--dev', '--data-dir', dataDir, '--http-port', String(port), '--max-sessions', String(opts.maxSessions ?? 5)]
    if (opts.ringBytes) args.push('--ring-bytes', String(opts.ringBytes))
    if (opts.extraArgs) args.push(...opts.extraArgs)
    return args
  }

  static async start(opts: AgentOptions = {}): Promise<Agent> {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), 'webterm-e2e-'))
    const proc = spawn(BINARY, Agent.args(port, dataDir, opts), { stdio: ['ignore', 'pipe', 'pipe'] })
    const agent = new Agent(proc, port, dataDir, opts)
    agent.collect(proc)
    await waitFor(async () => (await agent.healthy()) && agent.pairURL !== '', 'agent 启动并打出配对码')
    return agent
  }

  private collect(proc: ChildProcess): void {
    const on = (chunk: Buffer) => {
      this.log += chunk.toString()
      const m = this.log.match(/http:\/\/127\.0\.0\.1:\d+\/pair#[A-Za-z0-9_-]+/g)
      if (m) this.pairURL = m[m.length - 1]!
    }
    proc.stdout?.on('data', on)
    proc.stderr?.on('data', on)
  }

  private async healthy(): Promise<boolean> {
    try {
      return (await fetch(`${this.baseURL}/healthz`)).ok
    } catch {
      return false
    }
  }

  /**
   * 杀掉 agent 再在同一端口、同一数据目录起一个新进程（E2E-18 / E2E-36 ⑥）。
   * 设备与 Cookie 在数据库里，照样有效；会话全部消失、`instance_id` 变了（ADR-0003）。
   */
  async restart(): Promise<void> {
    const old = this.proc
    const exited = new Promise<void>((res) => old.once('exit', () => res()))
    old.kill('SIGKILL')
    await exited
    await waitFor(async () => !(await this.healthy()), '旧 agent 停止服务', 10_000)
    this.proc = spawn(BINARY, Agent.args(this.port, this.dataDir, this.opts), { stdio: ['ignore', 'pipe', 'pipe'] })
    this.collect(this.proc)
    await waitFor(() => this.healthy(), '新 agent 起来了')
  }

  /** 配对链接（fragment 里带着一次性配对码）。 */
  pairLink(): string {
    return this.pairURL
  }

  /** 同一次配对的数字码（ADR-0017），从 stdout 里抓 dddd-dddd-dddd-dddd。 */
  async pairDigits(): Promise<string> {
    let found = ''
    await waitFor(() => {
      const m = this.log.match(/\b(\d{4}-\d{4}-\d{4}-\d{4})\b/)
      if (m) found = m[1]!
      return found !== ''
    }, 'stdout 打出数字配对码', 10_000)
    return found
  }

  /** 现生成一个新的配对码，用于第二台设备。 */
  async newPairLink(): Promise<string> {
    const proc = spawn(BINARY, ['pair', '--dev', '--data-dir', this.dataDir, '--http-port', String(this.port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    await new Promise<void>((res) => proc.on('exit', () => res()))
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/pair#[A-Za-z0-9_-]+/)
    if (!m) throw new Error(`webterm pair 没有打出配对链接:\n${out}`)
    return m[0]
  }

  /**
   * 让 page 完成配对，之后它就带着会话 Cookie 了（停在 `/`）。
   * 启动时打出的那把码只能用一次：第二个 context 起自动 `webterm pair` 现生成一把。
   */
  async pair(page: Page): Promise<void> {
    const url = this.pairUsed ? await this.newPairLink() : this.pairURL
    this.pairUsed = true
    await page.goto(url)
    // 配对成功会跳回首页；失败则停在配对页并显示原因
    await page.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  }

  /** 配对 → 打开主界面 → 等到「在线」且有了第一个会话。 */
  async open(page: Page): Promise<void> {
    // 排障：连不上时把浏览器侧看到的 WebSocket 生命周期与 agent 日志一起打出来
    const t0 = Date.now()
    const wsLog: string[] = []
    page.on('pageerror', (e) => wsLog.push(`${Date.now() - t0}ms pageerror ${e.message}\n${e.stack ?? ''}`))
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') wsLog.push(`${Date.now() - t0}ms console.${m.type()} ${m.text()}`)
    })
    page.on('websocket', (ws) => {
      const at = () => `${Date.now() - t0}ms`
      wsLog.push(`${at()} open ${ws.url()}`)
      let rx = 0
      ws.on('framereceived', () => {
        if (rx++ === 0) wsLog.push(`${at()} first frame`)
      })
      ws.on('socketerror', (e) => wsLog.push(`${at()} error ${e}`))
      ws.on('close', () => wsLog.push(`${at()} close (rx ${rx})`))
    })
    await this.pair(page)
    try {
      await waitOnline(page)
    } catch (e) {
      const tail = this.log.split('\n').filter((l) => l.startsWith('time=')).slice(-10).join('\n')
      console.log(`[open] ${this.baseURL} 没连上\n  ws: ${wsLog.join(' | ') || '（没有 WebSocket）'}\n${tail}`)
      throw e
    }
    await waitFor(async () => (await hooks.sid(page)) !== null, '第一个会话就位')
  }

  logs(): string {
    return this.log
  }

  /** agent 进程的 pid。热升级原地 exec 之后它不变。 */
  pid(): number {
    return this.proc.pid ?? -1
  }

  /**
   * 热升级（ADR-0016 / E2E-26）：给 agent 发 SIGUSR2，它预检、冻结、交接、原地 exec
   * 同一个二进制。PID 不变，stdout 管道照旧 —— 这个 ChildProcess 句柄继续有效。
   */
  reexec(): void {
    this.proc.kill('SIGUSR2')
  }

  /** `webterm reload --probe`：返回退出码与 stdout（含 `generation=N`）。 */
  async reloadProbe(): Promise<{ code: number; out: string }> {
    const proc = spawn(BINARY, ['reload', '--probe', '--dev', '--data-dir', this.dataDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    const code = await new Promise<number>((res) => proc.on('exit', (c) => res(c ?? -1)))
    return { code, out }
  }

  stop(): void {
    this.proc.kill('SIGKILL')
    try {
      rmSync(this.dataDir, { recursive: true, force: true })
    } catch {
      /* 尽力而为 */
    }
  }
}

export async function waitFor(
  cond: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`超时等待：${what}`)
}

export async function waitOnline(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout })
}

/** 让当前会话的终端拿到焦点（不点：点终端在触屏上是「切换软键盘」，第二下会失焦）。 */
export async function focusTerm(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('.term .xterm-helper-textarea')?.focus())
}

/** 敲一条命令：聚焦终端 → 逐键键入 → 回车。 */
export async function submit(page: Page, text: string): Promise<void> {
  await focusTerm(page)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** 等终端缓冲（含 scrollback）里出现某段文字。 */
export async function waitText(page: Page, needle: string | RegExp, what?: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      const t = await terminalText(page)
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t)
    },
    what ?? `终端出现 ${String(needle)}`,
    timeoutMs,
  )
}

/** 数一段文字在缓冲里出现几次。 */
export function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** 终端当前的可见文本（含 scrollback）。 */
export async function terminalText(page: Page): Promise<string> {
  return hooks.text(page)
}

/** xterm 缓冲的序列化结果 —— 字节级比较用的就是它。 */
export async function serialize(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.serialize())
}

export async function outSeq(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.outSeq())
}

/** 最近一次 welcome —— 用来直接断言续传结果，而不是从 UI 反推。 */
export async function lastWelcome(page: Page): Promise<Welcome | null> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.welcome())
}

/** 前端算出来的终端尺寸。 */
export async function termSize(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.size())
}

export interface Welcome {
  instance_id: string
  resumed: { sid: number; status: string; in_ack: number }[]
  sessions: { sid: number; head_seq: number; cols: number; rows: number }[]
}

/** `__webterm.frames()` 的一项。 */
export interface FrameRec {
  type: number
  kind: 'OUTPUT' | 'SNAPSHOT'
  sid: number
  seq: number
  flags: number
  bytes: number
  replay: boolean
}

/** `__webterm.inputStats()`（AC-3.17）。 */
export interface InputStats {
  keydown: { n: number; agoMs: number }
  toTerm: { n: number; agoMs: number }
  data: { n: number; agoMs: number }
  sent: { n: number; agoMs: number }
  gated: number
  unackedBytes: number
  focus: string
  verdict: string
}

interface WebtermWindow {
  __webterm: {
    text(): string
    serialize(): string
    outSeq(): number
    size(): { cols: number; rows: number }
    welcome(): Welcome | null
    resizes(): number
    sid(): number | null
    form(): 'compact' | 'wide'
    fontSize(): number
    fontFamily(): string
    altScreen(): boolean
    unread(sid: number): boolean
    frames(): FrameRec[]
    scrollLines(n: number): void
    viewport(): { y: number; top: string }
    inputStats(): InputStats
  }
}

/** `window.__webterm` 的直通。 */
export const hooks = {
  text: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.text()),
  sid: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm?.sid() ?? null),
  form: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.form()),
  resizes: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.resizes()),
  size: (p: Page) => termSize(p),
  fontSize: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.fontSize()),
  fontFamily: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.fontFamily()),
  altScreen: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.altScreen()),
  unread: (p: Page, sid: number) => p.evaluate((s) => (window as unknown as WebtermWindow).__webterm.unread(s), sid),
  frames: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.frames()),
  scrollLines: (p: Page, n: number) => p.evaluate((k) => (window as unknown as WebtermWindow).__webterm.scrollLines(k), n),
  viewport: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.viewport()),
  inputStats: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.inputStats()),
  outSeq,
  serialize,
  welcome: lastWelcome,
}

/**
 * 收到的帧（`frames()` 只留最近 512 帧，按长度取差）。返回一个「从此刻起」的读取器：
 * 之后调用它拿到的是这之后新到的帧。
 */
export async function framesSince(page: Page): Promise<() => Promise<FrameRec[]>> {
  const base = (await hooks.frames(page)).length
  // 环形截断之后长度不再增长：此时退回到按「最后一帧」对齐
  const last = (await hooks.frames(page)).at(-1)
  return async () => {
    const all = await hooks.frames(page)
    if (all.length < 512) return all.slice(base)
    if (!last) return all
    const i = all.findIndex((f) => f.sid === last.sid && f.seq === last.seq && f.kind === last.kind && f.bytes === last.bytes)
    return i >= 0 ? all.slice(i + 1) : all
  }
}

/** 等某个会话收到一份完整的快照（最后一帧不带 MORE），返回这份快照的帧。 */
export async function waitSnapshot(
  read: () => Promise<FrameRec[]>,
  sid: number,
  what = `会话 ${sid} 收到 SNAPSHOT`,
  timeoutMs = 30_000,
): Promise<FrameRec[]> {
  let got: FrameRec[] = []
  await waitFor(async () => {
    const fs = (await read()).filter((f) => f.sid === sid && f.kind === 'SNAPSHOT')
    const end = fs.findIndex((f) => (f.flags & 1) === 0)
    if (end < 0) return false
    got = fs.slice(0, end + 1)
    return true
  }, what, timeoutMs)
  return got
}

// ---------- 发出去的东西 ----------

export interface SentRecorder {
  /** 发出去的控制消息，按顺序（解析过的 JSON）。 */
  ctl(): Promise<{ t: string; [k: string]: unknown }[]>
  /** 发出去的 INPUT 帧 payload（每帧一项，按 UTF-8 解成字符串）。 */
  input(): Promise<string[]>
  /** 同上，十六进制。 */
  inputHex(): Promise<string[]>
  /** 清空记录（之后的读数从零开始）。 */
  clear(): Promise<void>
}

/** hook `WebSocket.prototype.send`：记控制消息与 INPUT 帧。必须在页面加载之前装。 */
export async function recordSent(page: Page): Promise<SentRecorder> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ctl: unknown[]; __in: string[]; __inHex: string[] }
    w.__ctl = []
    w.__in = []
    w.__inHex = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (data: unknown) {
      if (typeof data === 'string') {
        try {
          w.__ctl.push(JSON.parse(data))
        } catch {
          /* 不是 JSON 就不记 */
        }
      } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data)
        if (b[0] === 0x02) {
          const p = b.subarray(12)
          w.__in.push(new TextDecoder().decode(p))
          w.__inHex.push([...p].map((x) => x.toString(16).padStart(2, '0')).join(''))
        }
      }
      return orig.call(this, data as never)
    }
  })
  type W = { __ctl: { t: string }[]; __in: string[]; __inHex: string[] }
  return {
    ctl: () => page.evaluate(() => (window as unknown as W).__ctl),
    input: () => page.evaluate(() => (window as unknown as W).__in),
    inputHex: () => page.evaluate(() => (window as unknown as W).__inHex),
    clear: () =>
      page.evaluate(() => {
        const w = window as unknown as W
        w.__ctl = []
        w.__in = []
        w.__inHex = []
      }),
  }
}

// ---------- 会话切换（两种形态） ----------

/** 抽屉 / 浮层的进场动画（约 170ms）落位：矩形两次读数相同。 */
export async function settled(page: Page, testid: string): Promise<void> {
  let last = ''
  await waitFor(async () => {
    const r = await page.getByTestId(testid).boundingBox()
    const s = JSON.stringify(r)
    const same = r !== null && s === last
    last = s
    return same
  }, `${testid} 动画结束`, 5_000)
}

/** compact：打开会话抽屉并等它落位。 */
export async function openDrawer(page: Page): Promise<void> {
  if (!(await page.getByTestId('session-drawer').count())) await page.getByTestId('open-sessions').click()
  await expect(page.getByTestId('session-drawer')).toBeVisible()
  await settled(page, 'session-drawer')
}

/** 新建一个会话并等它成为当前会话，返回新 sid。两种形态都走界面上的入口。 */
export async function newSession(page: Page): Promise<number> {
  const before = await hooks.sid(page)
  if ((await hooks.form(page)) === 'compact') {
    await openDrawer(page)
    await page.getByTestId('new-session').click()
  } else {
    await page.getByTestId('new-session').click()
  }
  let sid: number | null = null
  await waitFor(async () => {
    sid = await hooks.sid(page)
    return sid !== null && sid !== before
  }, '切到了新会话')
  return sid!
}

/** 切到某个会话（compact：抽屉里点那一行；wide：点标签）。 */
export async function switchTo(page: Page, sid: number): Promise<void> {
  if ((await hooks.form(page)) === 'compact') {
    await openDrawer(page)
    await page.getByTestId(`session-${sid}`).click()
  } else {
    await page.getByTestId(`tab-${sid}`).click()
  }
  await waitFor(async () => (await hooks.sid(page)) === sid, `切到会话 ${sid}`)
}

/**
 * 路由层面的 WebSocket 断开控制。
 *
 * 这是 e2e-scenarios.md 里的「方式一」，最贴近真实的网络中断，而且断点
 * 完全可控。CDP 的 offline 模拟对【已建立】的 WebSocket 不会立刻触发
 * onclose，页面会一直以为自己还在线 —— 那测的就不是断线了。
 *
 * 必须在页面打开 WebSocket 之前装。
 */
export interface WSControl {
  goOffline(): Promise<void>
  /**
   * 僵尸连接（E2E-33 / AC-2.20）：**已建立的那条两个方向都不再转发，但不关闭**。
   *
   * 这是息屏、切网、NAT 回收的样子 —— TCP 上没有 FIN，浏览器那边 `readyState`
   * 一直是 OPEN，页面自认在线。新连接则像线路断了一样直接失败。
   */
  goZombie(): void
  goOnline(): void
}

export async function installWSControl(page: Page): Promise<WSControl> {
  let online = true
  let zombie = false
  type Closer = { close(opts?: { code?: number; reason?: string }): Promise<void> | void }
  const live = new Set<{ page: Closer; server: Closer }>()

  await page.routeWebSocket('**/ws', (ws) => {
    if (!online) {
      ws.close({ code: 1006 }) // 1006 = 异常关闭，模拟线路断了
      return
    }
    const server = ws.connectToServer()
    const pair = { page: ws, server }
    live.add(pair)
    ws.onMessage((m) => {
      if (!zombie) server.send(m)
    })
    server.onMessage((m) => {
      if (!zombie) ws.send(m)
    })
    // 【关闭必须自己转发】：注册了 onClose 之后 Playwright 就不再默认转发关闭，
    // 页面自己调 ws.close()（心跳判死、探活判死走的就是这条）时，页面那边的
    // close 事件根本不会来 —— 应用永远停在"在线"，测的就不是真实行为了
    ws.onClose((code, reason) => {
      live.delete(pair)
      void ws.close({ code, reason })
      void server.close({ code, reason })
    })
    server.onClose((code, reason) => {
      live.delete(pair)
      void ws.close({ code, reason })
    })
  })

  return {
    async goOffline() {
      online = false
      // 【两头都关】：只关页面那头的话，agent 那头的连接还活着、还订阅着会话，
      // 输出照样经 Playwright 中继往一个已关闭的页面 socket 里灌 —— 断几次之后
      // 中继堆积，页面的事件派发被拖慢到十几秒（实测），测的就不是续传了
      for (const p of [...live]) {
        void p.page.close({ code: 1006 })
        // 关 agent 那头的码只能是 1000 或 3000–4999：中继 socket 是页面里的原生 WebSocket，
        // 别的码 close() 直接抛异常，那条连接就关不掉
        void p.server.close({ code: 1000, reason: 'e2e offline' })
      }
      live.clear()
      await page.waitForTimeout(50)
    },
    goZombie() {
      zombie = true // 活着的那条：黑洞，但不关
      online = false // 新连接：像线断了一样失败
    },
    goOnline() {
      zombie = false
      online = true
    },
  }
}

/** 在终端里三击包含 `needle` 的那一行（它得在可视区里），把整行选中。 */
export async function selectLine(page: Page, needle: string): Promise<void> {
  const pos = await page.evaluate((needle) => {
    const w = (window as unknown as WebtermWindow).__webterm
    const lines = w.text().split('\n')
    const idx = lines.findIndex((l) => l.includes(needle))
    const { y } = w.viewport()
    const rows = w.size().rows
    const s = document.querySelector('.term .xterm-screen')!.getBoundingClientRect()
    const cellH = s.height / rows
    return { x: s.left + 20, y: s.top + (idx - y + 0.5) * cellH, visible: idx >= y && idx < y + rows }
  }, needle)
  if (!pos.visible) throw new Error(`${needle} 不在可视区里，选不了`)
  await page.mouse.click(pos.x, pos.y, { clickCount: 3 })
}

/** 对 xterm 派发一次 copy 事件，返回它写进剪贴板的文字（= 当前选区）。 */
export async function copySelection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.term .xterm-helper-textarea')!
    const dt = new DataTransfer()
    ta.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
    return dt.getData('text/plain')
  })
}

/** 矩形（取整），量几何用。 */
export async function rectOf(page: Page, selector: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
  }, selector)
}
