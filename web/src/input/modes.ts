/**
 * 输入模式状态机 —— ADR-0007 / docs/40-frontend/input-modes.md §状态机。
 *
 * 它消费 shell 集成上报的 prompt 状态：停在 prompt → Composer，
 * 有命令在跑 → Raw。用户不需要理解"模式"这个概念，但需要时能手动锁定。
 */
import type { Integration, PromptState } from '../protocol/messages'

export type Mode = 'composer' | 'raw'

export interface ModeState {
  mode: Mode
  /** 用户手动指定过模式，自动切换暂停。 */
  locked: boolean
}

/**
 * 切到 Raw 的去抖（毫秒）。
 *
 * 瞬间结束的命令（ls、echo）会产生 running → done 只隔几毫秒的序列。
 * 直接切的话界面会闪一下 Raw 再回来，很难看。
 *
 * 【只对 running 去抖】—— 切回 Composer 必须立即，否则用户输入会被拖慢。
 */
export const RAW_DEBOUNCE_MS = 120

export interface ModeMachineOptions {
  onChange(state: ModeState): void
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}

export class ModeMachine {
  private state: ModeState = { mode: 'composer', locked: false }
  private lastPrompt: PromptState | null = null
  private integration: Integration = 'pending'
  private pendingRaw: ReturnType<typeof setTimeout> | undefined
  private readonly setTimer: NonNullable<ModeMachineOptions['setTimer']>
  private readonly clearTimer: NonNullable<ModeMachineOptions['clearTimer']>
  private readonly notify: ModeMachineOptions['onChange']

  constructor(opts: ModeMachineOptions) {
    this.notify = opts.onChange
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))
  }

  get current(): ModeState {
    return { ...this.state }
  }

  /** 自动切换是否可用 —— 集成失效时它就没有数据源了。 */
  get autoAvailable(): boolean {
    return this.integration === 'active'
  }

  /** 收到 prompt{state}。 */
  onPrompt(state: PromptState): void {
    this.lastPrompt = state
    if (this.state.locked || !this.autoAvailable) return
    if (state === 'running') {
      this.scheduleRaw()
      return
    }
    // input / done → 立即切回 Composer
    this.cancelPendingRaw()
    this.apply({ mode: 'composer' })
  }

  onIntegration(v: Integration): void {
    this.integration = v
    if (v !== 'active') {
      // 没有数据源了：固定 Composer，自动切换禁用，UI 显示降级提示
      this.cancelPendingRaw()
      this.apply({ mode: 'composer' })
    }
  }

  /** 用户手动切换 → 进入锁定，自动切换暂停。 */
  toggleManual(): void {
    this.cancelPendingRaw()
    this.apply({ mode: this.state.mode === 'composer' ? 'raw' : 'composer', locked: true })
  }

  setManual(mode: Mode): void {
    this.cancelPendingRaw()
    this.apply({ mode, locked: true })
  }

  /** 解锁自动 → 立即按最近的 prompt 状态重算。 */
  unlock(): void {
    this.state.locked = false
    if (!this.autoAvailable) {
      this.apply({ mode: 'composer', locked: false })
      return
    }
    const want: Mode = this.lastPrompt === 'running' ? 'raw' : 'composer'
    this.apply({ mode: want, locked: false })
  }

  /** 切换会话时重置：模式跟随会话，而且不该把上一个会话的手动选择带过来。 */
  reset(): void {
    this.cancelPendingRaw()
    this.lastPrompt = null
    this.integration = 'pending'
    this.apply({ mode: 'composer', locked: false })
  }

  dispose(): void {
    this.cancelPendingRaw()
  }

  private scheduleRaw(): void {
    if (this.pendingRaw !== undefined) return
    this.pendingRaw = this.setTimer(() => {
      this.pendingRaw = undefined
      if (!this.state.locked && this.autoAvailable) this.apply({ mode: 'raw' })
    }, RAW_DEBOUNCE_MS)
  }

  private cancelPendingRaw(): void {
    if (this.pendingRaw !== undefined) {
      this.clearTimer(this.pendingRaw)
      this.pendingRaw = undefined
    }
  }

  private apply(patch: Partial<ModeState>): void {
    const next = { ...this.state, ...patch }
    if (next.mode === this.state.mode && next.locked === this.state.locked) return
    this.state = next
    this.notify({ ...next })
  }
}
