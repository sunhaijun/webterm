/**
 * E2E 夹具：起真二进制、完成配对、给出操作终端的把手。
 *
 * 见 docs/70-testing/e2e-scenarios.md 的「测试夹具」。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'

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

export interface AgentOptions {
  /** 调小可以让 reset 路径可测；默认走 1 MiB，字节级比较才稳定。 */
  ringBytes?: number
  maxSessions?: number
  /** 不注入 shell 集成，用来测降级路径（E2E-13）。 */
  noShellIntegration?: boolean
}

export class Agent {
  readonly baseURL: string
  private readonly proc: ChildProcess
  private readonly dataDir: string
  private pairURL = ''
  private log = ''

  private constructor(proc: ChildProcess, port: number, dataDir: string) {
    this.proc = proc
    this.baseURL = `http://127.0.0.1:${port}`
    this.dataDir = dataDir
  }

  static async start(opts: AgentOptions = {}): Promise<Agent> {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), 'webterm-e2e-'))
    const args = [
      'serve',
      '--dev',
      '--data-dir',
      dataDir,
      '--http-port',
      String(port),
      '--max-sessions',
      String(opts.maxSessions ?? 5),
    ]
    if (opts.ringBytes) args.push('--ring-bytes', String(opts.ringBytes))
    if (opts.noShellIntegration) args.push('--no-shell-integration')

    const proc = spawn(BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const agent = new Agent(proc, port, dataDir)

    const collect = (chunk: Buffer) => {
      agent.log += chunk.toString()
      const m = agent.log.match(/http:\/\/127\.0\.0\.1:\d+\/pair#[A-Za-z0-9_-]+/)
      if (m) agent.pairURL = m[0]
    }
    proc.stdout?.on('data', collect)
    proc.stderr?.on('data', collect)

    await waitFor(async () => {
      try {
        const r = await fetch(`${agent.baseURL}/healthz`)
        return r.ok && agent.pairURL !== ''
      } catch {
        return false
      }
    }, 'agent 启动并打出配对码')
    return agent
  }

  /** 配对链接（fragment 里带着一次性配对码）。 */
  pairLink(): string {
    return this.pairURL
  }

  /** 让 page 完成配对，之后它就带着会话 Cookie 了。 */
  async pair(page: Page): Promise<void> {
    await page.goto(this.pairURL)
    // 配对成功会跳回首页；失败则停在配对页并显示原因
    await page.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  }

  logs(): string {
    return this.log
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

/** 往 Composer 里敲一条命令并提交。 */
export async function submit(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId('composer')
  await composer.click()
  await composer.fill(text)
  await composer.press('Enter')
}

/** 终端当前的可见文本（含 scrollback）。 */
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.text())
}

/** xterm 缓冲的序列化结果 —— 字节级比较用的就是它。 */
export async function serialize(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.serialize())
}

export async function outSeq(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.outSeq())
}

/** 最近一次 welcome —— 用来直接断言续传结果，而不是从 UI 反推。 */
export async function lastWelcome(page: Page): Promise<{
  instance_id: string
  resumed: { sid: number; status: string; from_seq: number; in_ack: number }[]
} | null> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.welcome())
}

/** 前端算出来的终端尺寸。 */
export async function termSize(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.size())
}

interface WebtermWindow {
  __webterm: {
    text(): string
    serialize(): string
    outSeq(): number
    size(): { cols: number; rows: number }
    mode(): { mode: string; locked: boolean }
    welcome(): {
      instance_id: string
      resumed: { sid: number; status: string; from_seq: number; in_ack: number }[]
    } | null
  }
}

/**
 * 路由层面的 WebSocket 断开控制。
 *
 * 这是 e2e-scenarios.md 里的「方式一」，最贴近真实的网络中断，而且断点
 * 完全可控。CDP 的 offline 模拟对【已建立】的 WebSocket 不会立刻触发
 * onclose，页面会一直以为自己还在线 —— 那测的就不是断线了。
 *
 * 必须在 page.goto 之前装。
 */
export interface WSControl {
  goOffline(): Promise<void>
  goOnline(): void
}

export async function installWSControl(page: Page): Promise<WSControl> {
  let online = true
  const live = new Set<{ close(opts?: { code?: number }): void }>()

  await page.routeWebSocket('**/ws', (ws) => {
    if (!online) {
      ws.close({ code: 1006 }) // 1006 = 异常关闭，模拟线路断了
      return
    }
    const server = ws.connectToServer()
    live.add(ws)
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => ws.send(m))
    ws.onClose(() => live.delete(ws))
  })

  return {
    async goOffline() {
      online = false
      for (const ws of [...live]) ws.close({ code: 1006 })
      live.clear()
      await page.waitForTimeout(50)
    },
    goOnline() {
      online = true
    },
  }
}
