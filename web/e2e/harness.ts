/**
 * E2E harness: starts the real binary, pairs a browser, and exposes handles for driving the terminal.
 *
 * See "Test harness" in docs/70-testing/e2e-scenarios.md. The UI is the Termux-style one from
 * ADR-0025: no input modes, no composer. To run a command, focus the terminal and type.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, type Page } from '@playwright/test'

/** freePort lets the kernel pick an unused port. Guessing collides under parallel or back-to-back runs. */
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
        srv.close(() => rej(new Error('could not get a free port')))
      }
    })
  })
}

const REPO = resolve(process.cwd(), '..')
const BINARY = join(REPO, 'webterm')

/** Fixture scripts directory. Absolute, because sessions start in $HOME. */
export const FIXTURES = resolve(process.cwd(), 'e2e/fixtures')
/** `emit.sh <lines> [delay ms per line]`: deterministic output for byte-level comparisons. */
export const EMIT = `bash ${FIXTURES}/emit.sh`
/** `altscreen.sh <busy seconds> <done marker file>`: a fake full-screen TUI (E2E-31 / E2E-36). */
export const ALTSCREEN = `bash ${FIXTURES}/altscreen.sh`

export interface AgentOptions {
  /**
   * Per-session ring buffer size. Defaults to the agent's own default (256 KiB), so output produced
   * while disconnected never overflows and incremental-path byte comparisons stay stable. Only the
   * snapshot-path scenarios (E2E-2c / 4 / 30 / 31) lower it to 65536.
   */
  ringBytes?: number
  maxSessions?: number
  /** Extra `serve` flags, for debugging (e.g. `--log-level debug`). */
  extraArgs?: string[]
}

export class Agent {
  readonly baseURL: string
  private proc: ChildProcess
  private readonly dataDir: string
  private readonly opts: AgentOptions
  private pairURL = ''
  /** Output of the `webterm pair` run that minted pairURL (it also carries the digits). */
  private pairOut = ''
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

  /** The agent's environment: its own TMPDIR, so uploads (ADR-0051) land in `uploadDir()`. */
  private static env(dataDir: string): NodeJS.ProcessEnv {
    return { ...process.env, TMPDIR: join(dataDir, 'tmp') }
  }

  /** Where `POST /api/uploads` saves files: `$TMPDIR/webterm-<uid>/uploads`. */
  uploadDir(): string {
    return join(this.dataDir, 'tmp', `webterm-${process.getuid?.() ?? 0}`, 'uploads')
  }

  static async start(opts: AgentOptions = {}): Promise<Agent> {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), 'webterm-e2e-'))
    mkdirSync(join(dataDir, 'tmp'), { mode: 0o700 })
    const proc = spawn(BINARY, Agent.args(port, dataDir, opts), { stdio: ['ignore', 'pipe', 'pipe'], env: Agent.env(dataDir) })
    const agent = new Agent(proc, port, dataDir, opts)
    agent.collect(proc)
    await waitFor(() => agent.healthy(), 'agent started')
    // serve prints a pairing code only to a terminal (AC-1.3); this is a pipe, so mint one the
    // way an admin would.
    const first = await agent.mintPair()
    agent.pairURL = first.url
    agent.pairOut = first.out
    return agent
  }

  private collect(proc: ChildProcess): void {
    const on = (chunk: Buffer) => {
      this.log += chunk.toString()
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
   * restart kills the agent and starts a new process on the same port and data dir (E2E-18 / E2E-36 (6)).
   * Devices and cookies live in the database and stay valid; all sessions are gone and `instance_id`
   * changes (ADR-0003).
   */
  async restart(): Promise<void> {
    const old = this.proc
    const exited = new Promise<void>((res) => old.once('exit', () => res()))
    old.kill('SIGKILL')
    await exited
    await waitFor(async () => !(await this.healthy()), 'old agent stopped serving', 10_000)
    this.proc = spawn(BINARY, Agent.args(this.port, this.dataDir, this.opts), { stdio: ['ignore', 'pipe', 'pipe'], env: Agent.env(this.dataDir) })
    this.collect(this.proc)
    await waitFor(() => this.healthy(), 'new agent is up')
  }

  /**
   * attach runs `webterm attach <args>` on a PTY of cols×rows (`e2e/fixtures/ptyrun.py`), as
   * `ssh -t` would (E2E-47). Never with the developer's own `WEBTERM_SESSION` or config.
   */
  attach(cols: number, rows: number, ...args: string[]): AttachProc {
    const proc = spawn('python3', [join(FIXTURES, 'ptyrun.py'), String(cols), String(rows), '--', BINARY, 'attach', '--data-dir', this.dataDir, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: attachEnv(this.dataDir),
    })
    return new AttachProc(proc)
  }

  /** attachList runs `webterm attach --list` without a terminal. */
  attachList(): Promise<{ code: number; out: string }> {
    const proc = spawn(BINARY, ['attach', '--data-dir', this.dataDir, '--list'], { stdio: ['ignore', 'pipe', 'pipe'], env: attachEnv(this.dataDir) })
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    return new Promise((res) => proc.once('exit', (code) => res({ code: code ?? -1, out })))
  }

  /** pairLink returns the pairing URL; the one-time pairing code is in the fragment. */
  pairLink(): string {
    return this.pairURL
  }

  /** pairDigits returns the numeric form of the same pairing code (ADR-0017), as printed: dddd-dddd-dddd-dddd. */
  async pairDigits(): Promise<string> {
    const m = this.pairOut.match(/\b(\d{4}-\d{4}-\d{4}-\d{4})\b/)
    if (!m) throw new Error(`webterm pair printed no numeric code:\n${this.pairOut}`)
    return m[1]!
  }

  /** newPairLink mints a fresh pairing code, for a second device. */
  async newPairLink(): Promise<string> {
    return (await this.mintPair()).url
  }

  /** mintPair runs `webterm pair` and returns the pairing link with the full output. */
  private async mintPair(): Promise<{ url: string; out: string }> {
    const proc = spawn(BINARY, ['pair', '--dev', '--data-dir', this.dataDir, '--http-port', String(this.port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    await new Promise<void>((res) => proc.on('exit', () => res()))
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/pair#[A-Za-z0-9_-]+/)
    if (!m) throw new Error(`webterm pair printed no pairing link:\n${out}`)
    return { url: m[0], out }
  }

  /**
   * pair pairs the page; afterwards it carries a session cookie and sits on `/`.
   * The code printed at startup is single-use, so from the second context on this runs
   * `webterm pair` to mint a new one.
   */
  async pair(page: Page): Promise<void> {
    const url = this.pairUsed ? await this.newPairLink() : this.pairURL
    this.pairUsed = true
    await page.goto(url)
    // Success redirects to `/`; failure stays on the pairing page and shows the reason.
    await page.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  }

  /** open pairs, loads the main UI, and waits until it is online with a first session. */
  async open(page: Page): Promise<void> {
    // Diagnostics: if the connection never comes up, dump the browser-side WebSocket lifecycle next to the agent log.
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
      console.log(`[open] ${this.baseURL} never came online\n  ws: ${wsLog.join(' | ') || '(no WebSocket)'}\n${tail}`)
      throw e
    }
    await waitFor(async () => (await hooks.sid(page)) !== null, 'first session is ready')
  }

  logs(): string {
    return this.log
  }

  /** pid is the agent's process ID. It survives an in-place exec during hot upgrade. */
  pid(): number {
    return this.proc.pid ?? -1
  }

  /**
   * reexec triggers a hot upgrade (ADR-0016 / E2E-26): SIGUSR2 makes the agent preflight, freeze,
   * hand off, and exec the same binary in place. The PID and the stdout pipe stay the same, so this
   * ChildProcess handle remains valid.
   */
  reexec(): void {
    this.proc.kill('SIGUSR2')
  }

  /** reloadProbe runs `webterm reload --probe` and returns its exit code and stdout (which includes `generation=N`). */
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
      /* best effort */
    }
  }
}

function attachEnv(dataDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: join(dataDir, 'no-config') }
  delete env.WEBTERM_SESSION // the runner may itself be inside a webterm session
  return env
}

/** AttachProc is a running `webterm attach` (see Agent.attach). */
export class AttachProc {
  private out = Buffer.alloc(0)
  readonly exited: Promise<number>

  constructor(private readonly proc: ChildProcess) {
    proc.stdout?.on('data', (c: Buffer) => (this.out = Buffer.concat([this.out, c])))
    proc.stderr?.on('data', (c: Buffer) => (this.out = Buffer.concat([this.out, c])))
    this.exited = new Promise((res) => proc.once('exit', (code) => res(code ?? -1)))
  }

  /** Everything the client wrote to its terminal, decoded as UTF-8. */
  output(): string {
    return this.out.toString('utf8')
  }

  /** write types into the client's terminal. */
  write(s: string): void {
    this.proc.stdin?.write(s)
  }

  /** hangUp closes the terminal, as ssh going away does (the wrapper sends SIGHUP). */
  hangUp(): void {
    this.proc.stdin?.end()
  }

  kill(): void {
    this.proc.kill('SIGKILL')
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
  throw new Error(`timed out waiting for: ${what}`)
}

export async function waitOnline(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId('conn-text')).toHaveText('Online', { timeout })
}

/**
 * focusTerm focuses the current session's terminal without clicking it: on touch devices a click
 * toggles the on-screen keyboard, so a second click would blur it.
 */
export async function focusTerm(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector<HTMLTextAreaElement>('.term .xterm-helper-textarea')?.focus())
}

/** submit types a command into the terminal key by key, then presses Enter. */
export async function submit(page: Page, text: string): Promise<void> {
  await focusTerm(page)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** waitText waits until the terminal buffer, scrollback included, contains `needle`. */
export async function waitText(page: Page, needle: string | RegExp, what?: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    async () => {
      const t = await terminalText(page)
      return typeof needle === 'string' ? t.includes(needle) : needle.test(t)
    },
    what ?? `terminal shows ${String(needle)}`,
    timeoutMs,
  )
}

/** count returns how many times `needle` occurs in `haystack`. */
export function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** terminalText returns the terminal's text, scrollback included. */
export async function terminalText(page: Page): Promise<string> {
  return hooks.text(page)
}

/** serialize returns the serialized xterm buffer, which is what byte-level comparisons use. */
export async function serialize(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.serialize())
}

export async function outSeq(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.outSeq())
}

/** lastWelcome returns the most recent welcome, so tests assert the resume result directly instead of inferring it from the UI. */
export async function lastWelcome(page: Page): Promise<Welcome | null> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.welcome())
}

/** termSize returns the terminal size the frontend computed. */
export async function termSize(page: Page): Promise<{ cols: number; rows: number }> {
  return page.evaluate(() => (window as unknown as WebtermWindow).__webterm.size())
}

export interface Welcome {
  instance_id: string
  resumed: { sid: number; status: string; in_ack: number }[]
  sessions: { sid: number; head_seq: number; cols: number; rows: number }[]
}

/** FrameRec is one entry of `__webterm.frames()`. */
export interface FrameRec {
  type: number
  kind: 'OUTPUT' | 'SNAPSHOT'
  sid: number
  seq: number
  flags: number
  bytes: number
  replay: boolean
}

/** InputStats mirrors `__webterm.inputStats()` (AC-3.17). */
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
    sessionSize(): { cols: number; rows: number }
    welcome(): Welcome | null
    resizes(): number
    sid(): number | null
    form(): 'compact' | 'wide'
    fontSize(): number
    altScreen(): boolean
    attention(sid: number): boolean
    frames(): FrameRec[]
    scrollLines(n: number): void
    viewport(): { y: number; top: string }
    inputStats(): InputStats
  }
}

/** hooks passes straight through to `window.__webterm`. */
export const hooks = {
  text: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.text()),
  sid: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm?.sid() ?? null),
  form: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.form()),
  fontSize: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.fontSize()),
  resizes: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.resizes()),
  size: (p: Page) => termSize(p),
  sessionSize: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.sessionSize()),
  altScreen: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.altScreen()),
  attention: (p: Page, sid: number) => p.evaluate((s) => (window as unknown as WebtermWindow).__webterm.attention(s), sid),
  frames: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.frames()),
  scrollLines: (p: Page, n: number) => p.evaluate((k) => (window as unknown as WebtermWindow).__webterm.scrollLines(k), n),
  viewport: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.viewport()),
  inputStats: (p: Page) => p.evaluate(() => (window as unknown as WebtermWindow).__webterm.inputStats()),
  outSeq,
  serialize,
  welcome: lastWelcome,
}

/**
 * framesSince returns a reader for frames received from now on. `frames()` keeps only the last
 * 512 frames, so the reader slices by length.
 */
export async function framesSince(page: Page): Promise<() => Promise<FrameRec[]>> {
  const base = (await hooks.frames(page)).length
  // Once the ring is full the length stops growing; fall back to aligning on the last frame seen.
  const last = (await hooks.frames(page)).at(-1)
  return async () => {
    const all = await hooks.frames(page)
    if (all.length < 512) return all.slice(base)
    if (!last) return all
    const i = all.findIndex((f) => f.sid === last.sid && f.seq === last.seq && f.kind === last.kind && f.bytes === last.bytes)
    return i >= 0 ? all.slice(i + 1) : all
  }
}

/** waitSnapshot waits for a complete snapshot for `sid` (last frame without MORE) and returns its frames. */
export async function waitSnapshot(
  read: () => Promise<FrameRec[]>,
  sid: number,
  what = `session ${sid} received a SNAPSHOT`,
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

// ---------- Outgoing traffic ----------

export interface SentRecorder {
  /** ctl returns sent control messages in order, parsed from JSON. */
  ctl(): Promise<{ t: string; [k: string]: unknown }[]>
  /** input returns sent INPUT frame payloads, one entry per frame, decoded as UTF-8. */
  input(): Promise<string[]>
  /** inputHex is like input, but hex-encoded. */
  inputHex(): Promise<string[]>
  /** inputOf is like input, but only the frames for one session. */
  inputOf(sid: number): Promise<string[]>
  /** clear resets the recording. */
  clear(): Promise<void>
}

/** recordSent hooks `WebSocket.prototype.send` to record control messages and INPUT frames. Install it before the page loads. */
export async function recordSent(page: Page): Promise<SentRecorder> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ctl: unknown[]; __in: string[]; __inHex: string[]; __inSid: number[] }
    w.__ctl = []
    w.__in = []
    w.__inHex = []
    w.__inSid = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (data: unknown) {
      if (typeof data === 'string') {
        try {
          w.__ctl.push(JSON.parse(data))
        } catch {
          /* not JSON; skip */
        }
      } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data)
        if (b[0] === 0x02) {
          const p = b.subarray(12)
          w.__in.push(new TextDecoder().decode(p))
          w.__inHex.push([...p].map((x) => x.toString(16).padStart(2, '0')).join(''))
          w.__inSid.push((b[2]! << 8) | b[3]!)
        }
      }
      return orig.call(this, data as never)
    }
  })
  type W = { __ctl: { t: string }[]; __in: string[]; __inHex: string[]; __inSid: number[] }
  return {
    ctl: () => page.evaluate(() => (window as unknown as W).__ctl),
    input: () => page.evaluate(() => (window as unknown as W).__in),
    inputHex: () => page.evaluate(() => (window as unknown as W).__inHex),
    inputOf: (sid: number) =>
      page.evaluate((s) => {
        const w = window as unknown as W
        return w.__in.filter((_, i) => w.__inSid[i] === s)
      }, sid),
    clear: () =>
      page.evaluate(() => {
        const w = window as unknown as W
        w.__ctl = []
        w.__in = []
        w.__inHex = []
        w.__inSid = []
      }),
  }
}

// ---------- Switching sessions (both forms) ----------

/** settled waits for a drawer or sheet's enter animation (~170ms) to finish: two identical rect readings in a row. */
export async function settled(page: Page, testid: string): Promise<void> {
  let last = ''
  await waitFor(async () => {
    const r = await page.getByTestId(testid).boundingBox()
    const s = JSON.stringify(r)
    const same = r !== null && s === last
    last = s
    return same
  }, `${testid} animation finished`, 5_000)
}

/** openDrawer opens the session drawer (compact form) and waits for it to settle. */
export async function openDrawer(page: Page): Promise<void> {
  if (!(await page.getByTestId('session-drawer').count())) await page.getByTestId('open-sessions').click()
  await expect(page.getByTestId('session-drawer')).toBeVisible()
  await settled(page, 'session-drawer')
}

/** newSession creates a session through the UI (either form), waits for it to become current, and returns its sid. */
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
  }, 'switched to the new session')
  return sid!
}

/** switchTo switches to a session: compact clicks its row in the drawer, wide clicks its tab. */
export async function switchTo(page: Page, sid: number): Promise<void> {
  if ((await hooks.form(page)) === 'compact') {
    await openDrawer(page)
    await page.getByTestId(`session-${sid}`).click()
  } else {
    await page.getByTestId(`tab-${sid}`).click()
  }
  await waitFor(async () => (await hooks.sid(page)) === sid, `switched to session ${sid}`)
}

/**
 * WSControl cuts the WebSocket at the routing layer.
 *
 * This is "method 1" in e2e-scenarios.md: closest to a real network drop, with full control over
 * where the cut happens. CDP offline emulation does not fire onclose on an already-open WebSocket,
 * so the page would keep believing it is online and the test would not be testing a disconnect.
 *
 * Install it before the page opens its WebSocket.
 */
export interface WSControl {
  goOffline(): Promise<void>
  /**
   * goZombie simulates a zombie connection (E2E-33 / AC-2.20): the open socket stops forwarding in
   * both directions but is never closed.
   *
   * This is what screen-off, network switches, and NAT expiry look like: no FIN on the wire,
   * `readyState` stays OPEN, and the page thinks it is online. New connections fail as if the line
   * were down.
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
      ws.close({ code: 1006 }) // 1006 = abnormal closure, i.e. the line dropped
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
    // Forward closes ourselves: once onClose is registered, Playwright stops forwarding them. When
    // the page calls ws.close() itself (heartbeat or liveness probe declaring the socket dead), the
    // page would never see a close event and the app would stay "online" forever.
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
      // Close both ends. If only the page end closes, the agent end stays subscribed and keeps
      // pushing output through the Playwright relay into a closed page socket. After a few cuts the
      // relay backs up and page event dispatch slows to 10+ seconds, which is no longer a resume test.
      for (const p of [...live]) {
        void p.page.close({ code: 1006 })
        // The agent end is a native WebSocket inside the page, so its close code must be 1000 or
        // 3000-4999. Any other code makes close() throw and the connection stays open.
        void p.server.close({ code: 1000, reason: 'e2e offline' })
      }
      live.clear()
      await page.waitForTimeout(50)
    },
    goZombie() {
      zombie = true // the open socket: black hole, but not closed
      online = false // new connections: fail as if the line were down
    },
    goOnline() {
      zombie = false
      online = true
    },
  }
}

/** selectLine triple-clicks the terminal line containing `needle` to select it. The line must be in the viewport. */
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
  if (!pos.visible) throw new Error(`${needle} is outside the viewport; cannot select it`)
  await page.mouse.click(pos.x, pos.y, { clickCount: 3 })
}

/** copySelection dispatches a copy event on xterm and returns the text it put on the clipboard (the current selection). */
export async function copySelection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.term .xterm-helper-textarea')!
    const dt = new DataTransfer()
    ta.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
    return dt.getData('text/plain')
  })
}

/** rectOf returns an element's bounding rect, rounded, for geometry assertions. */
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
