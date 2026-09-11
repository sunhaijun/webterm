/**
 * 输入模式状态机 —— ADR-0007 / docs/40-frontend/input-modes.md §状态机。
 *
 * 它消费 shell 集成上报的 prompt 状态：停在 prompt → Composer，
 * 有命令在跑 → Raw。全自动，没有手动开关 —— 用户不需要理解"模式"这个概念。
 */
import type { Integration, PromptState } from '../protocol/messages'

export type Mode = 'composer' | 'raw'

export interface ModeState {
  mode: Mode
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
  private state: ModeState = { mode: 'composer' }
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

  /**
   * 重连后按 welcome.sessions[].prompt_state 重新对齐。
   *
   * 集成不可用时不动 —— 没有数据源，维持当前 Composer。
   */
  resync(state: PromptState | null): void {
    if (state === null || !this.autoAvailable) return
    this.cancelPendingRaw()
    this.apply({ mode: state === 'running' ? 'raw' : 'composer' })
  }

  /** 收到 prompt{state}。 */
  onPrompt(state: PromptState): void {
    if (!this.autoAvailable) return
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

  /** 切换会话时重置：模式跟随会话，不把上一个会话的状态带过来。 */
  reset(): void {
    this.cancelPendingRaw()
    this.integration = 'pending'
    this.apply({ mode: 'composer' })
  }

  dispose(): void {
    this.cancelPendingRaw()
  }

  private scheduleRaw(): void {
    if (this.pendingRaw !== undefined) return
    this.pendingRaw = this.setTimer(() => {
      this.pendingRaw = undefined
      if (this.autoAvailable) this.apply({ mode: 'raw' })
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
    if (next.mode === this.state.mode) return
    this.state = next
    this.notify({ ...next })
  }
}
