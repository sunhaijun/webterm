/**
 * 双指缩放读（ADR-0013）。
 *
 * 终端固定 43 列。读方案文 / 长输出时想凑近看，这里给终端一个【纯视觉】的双指放大：
 * 只对 `.xterm-screen` 施加 CSS transform（scale + translate），**不动 PTY 尺寸**
 * （不 fit、不发 resize），所以放大只是把当前屏看得更清，程序的折行位置不变。
 *
 * 放大【锚在双指中点】：手指按住哪儿就放大哪儿，捏合时那一点不跑；放大后单指可平移；
 * 双击在点下处放大到 2×，再双击复位；缩回 1× 也复位。隐藏 textarea 不在变换内，打字照常。
 *
 * 单指手势在 1× 下还要和【横滑切会话】(AC-4.7) 分家：前 12px 谁占优谁拿走整段手势
 * （`hswipe.ts` 的轴锁），纵向 → 滚 scrollback，横向 → 跟手位移 + 松手切会话。
 * 放大态不参与：那时单指是平移画面。仲裁表见 docs/40-frontend/session-ux.md §左右滑动切换。
 */
import { lockAxis, switchDelta, type Axis } from './hswipe'
import { decay, moving, sample, shouldFling } from './inertia'

/** 切换 / 弹回的位移动画时长。 */
const SLIDE_MS = 160

/** 缩放上下限。1× = 原样；3× 已经很大了。 */
export const MIN_SCALE = 1
export const MAX_SCALE = 3
/** 双击放大到的倍数。 */
export const TAP_SCALE = 2
/** 算「一次轻点」的上限：动得比这多、按得比这久，就不是点，是拖或长按。 */
const TAP_SLOP_PX = 10
const TAP_MS = 250
/** 两次轻点之间不超过它才算双击。 */
const DOUBLE_TAP_MS = 300

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

/** 两点距离。 */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

/**
 * 平移量夹紧：放大 scale 倍后，内容比容器大 (scale-1)*size，平移不能把内容拖出边。
 * 返回夹紧到 [-(scale-1)*size, 0] 的值（transform-origin 在左上角）。
 */
export function clampPan(t: number, scale: number, size: number): number {
  const min = -(scale - 1) * size
  const r = Math.min(0, Math.max(min, t))
  return r === 0 ? 0 : r // 规避 -0
}

/**
 * 锚定平移：手势开始时锚点（屏内坐标）`startMid` 下压着的那个内容点，缩放到 `scale`
 * 后仍要压在当前锚点 `mid` 下。transform-origin 在左上角，屏坐标 = 内容坐标 * scale + t。
 * 手势起点：`startMid` 下的内容点 p0 = (startMid − startT) / startScale；要 p0*scale + t = mid，
 * 于是 t = mid − p0*scale。`mid` 随双指中点漂移 → 顺带实现了「捏着拖」。
 */
export function anchorTranslate(mid: number, startMid: number, startT: number, startScale: number, scale: number): number {
  const p0 = (startMid - startT) / startScale
  return mid - p0 * scale
}

export interface Pinch {
  scale(): number
  reset(): void
  dispose(): void
}

export interface PinchOptions {
  /**
   * 横滑切会话（AC-4.7）。`delta` 是 `+1` 下一个 / `-1` 上一个。
   * 返回【是否真的切了】—— 没切就把跟手的位移弹回去。
   */
  onSwitch?(delta: -1 | 1): boolean
  /** 现在有没有可切的目标。只有一个会话时不接管横向手势，别给假反馈。 */
  canSwitch?(): boolean
}

/** 给 `.term` 容器装上双指缩放 + 单指横滑切会话。host 是 `.term`（xterm 挂在它里面）。 */
export function installPinch(host: HTMLElement, opts: PinchOptions = {}): Pinch {
  let scale = 1
  let tx = 0
  let ty = 0
  // 手势起点
  let startDist = 0
  let startScale = 1
  let startTx = 0
  let startTy = 0
  let startMidX = 0
  let startMidY = 0
  // 单指平移
  let panX = 0
  let panY = 0
  /** 上一次【确实是轻点】的结束时刻。
   *  【不能记 touchstart 的时刻】：那样任何两次快速触摸都算双击 —— 连着横滑两次切会话，
   *  第二下会被吃掉变成放大（E2E-29 抓到的就是这个）。 */
  let lastTapAt = 0
  /** 本次手势走过的最大位移，用来判断它是不是轻点。 */
  let moved = 0
  /** 这一下被双击吃掉了：后面的 move / end 都不再当成拖动。 */
  let consumed = false
  // 单指纵向拖：每帧落一次 scrollTop + 松手惯性（AC-5.15）
  /** 手势开始时缓存的滚动容器。别在每个 touchmove 里 querySelector。 */
  let vpEl: HTMLElement | null = null
  /** 本帧还没落地的位移（手指坐标系，向下为正）。 */
  let pendingDy = 0
  let scrollRaf = 0
  /** 平滑后的末速度（px/ms）。按帧采样，见 flushScroll。 */
  let vy = 0
  /** 最后一次 touchmove 的时刻 —— 判"停住再抬手不算甩动"。 */
  let lastMoveAt = 0
  /** 最后一次采速度的时刻。 */
  let lastSampleAt = 0
  let flingRaf = 0
  // 单指手势的轴锁与横滑（AC-4.7）
  let axis: Axis = 'none'
  let startX = 0
  let startY = 0
  let startAt = 0
  let dragX = 0

  const screen = () => host.querySelector<HTMLElement>('.xterm-screen')
  // 当前会话的容器（`.term` 里只挂着活动会话那一个）。横滑位移作用在它身上：
  // 纯 transform，不改 clientWidth/Height，所以 ResizeObserver 不响、不 fit、不发 resize。
  const pageEl = () => host.querySelector<HTMLElement>('.term-host')
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  // xterm 的滚动容器。它和触点所在的 .xterm-screen 是【兄弟】—— 触点不在它里面，
  // 所以原生触摸滚不动它（会漏给页面），单指回滚只能 JS 直接改它的 scrollTop。
  const viewport = () => host.querySelector<HTMLElement>('.xterm-viewport')
  // 屏内（相对 host 左上角）坐标
  const localX = (clientX: number) => clientX - host.getBoundingClientRect().left
  const localY = (clientY: number) => clientY - host.getBoundingClientRect().top

  /**
   * 把攒下的位移落到滚动容器上 —— 每帧至多一次（AC-5.15）。
   *
   * touchmove 是主线程事件，逐次改 scrollTop 等于一帧里同步布局好几遍；而且改了
   * 也只有最后一次看得见。攒起来在 rAF 里落一次，既跟手又只付一次布局。
   */
  const flushScroll = () => {
    scrollRaf = 0
    const dy = pendingDy
    pendingDy = 0
    if (!vpEl || dy === 0) return
    // 速度【按帧采】：一帧里堆了几个 touchmove 也只算一个样本（inertia.sample）
    const now = performance.now()
    vy = sample(vy, dy, now - lastSampleAt)
    lastSampleAt = now
    vpEl.scrollTop -= dy
  }

  const stopFling = () => {
    if (flingRaf) cancelAnimationFrame(flingRaf)
    flingRaf = 0
  }

  /** 松手后按末速度滑行。碰到边界、速度见底、下一次触摸，三者任一立刻停。 */
  const startFling = () => {
    const vp = vpEl
    if (!vp) return
    let v = vy
    let last = performance.now()
    const step = (now: number) => {
      const dt = now - last
      last = now
      const before = vp.scrollTop
      vp.scrollTop -= v * dt
      // 撞到顶 / 底：再滑也不动了，别空转一串帧
      if (vp.scrollTop === before) {
        flingRaf = 0
        return
      }
      v = decay(v, dt)
      flingRaf = moving(v) ? requestAnimationFrame(step) : 0
    }
    flingRaf = requestAnimationFrame(step)
  }

  const apply = () => {
    const el = screen()
    if (!el) return
    if (scale <= 1.001) {
      scale = 1
      tx = 0
      ty = 0
      el.style.transform = ''
      el.style.transformOrigin = ''
      host.removeAttribute('data-zoom')
      return
    }
    tx = clampPan(tx, scale, host.clientWidth)
    ty = clampPan(ty, scale, host.clientHeight)
    el.style.transformOrigin = '0 0'
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    host.setAttribute('data-zoom', scale.toFixed(2))
  }

  /** 把某一页横移到 px。animate 时补一个收尾把 inline 样式清干净（别留下常驻 transform）。 */
  const slideTo = (el: HTMLElement, px: number, animate: boolean) => {
    const clear = () => {
      if (el.style.transform === 'translateX(0px)') {
        el.style.transform = ''
        el.style.transition = ''
      }
    }
    el.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out` : 'none'
    el.style.transform = `translateX(${px}px)`
    if (px === 0) {
      if (!animate) clear()
      else {
        el.addEventListener('transitionend', clear, { once: true })
        setTimeout(clear, SLIDE_MS + 80) // transitionend 不保证来（元素被摘掉 / 动画被跳过）
      }
    }
  }

  /** 松手：过阈值就切会话并让新的一页接着滑进来，否则弹回。 */
  const endSwipe = (cancelled: boolean) => {
    const el = pageEl()
    const w = host.clientWidth || 1
    const delta = cancelled ? 0 : switchDelta(dragX, Date.now() - startAt)
    const reduced = reducedMotion()
    if (delta !== 0 && opts.onSwitch?.(delta)) {
      // onSwitch 里已经把新会话挂上来了（store.activate 是同步的）
      const next = pageEl()
      // 旧的那一页还在 store 里留着（切回来还用它），它的 inline 位移必须清掉
      if (el && el !== next) slideTo(el, 0, false)
      if (next && next !== el && !reduced) {
        // 接着手指的位置进场：旧页被推到哪儿，新页的边就在哪儿
        slideTo(next, dragX + (delta === 1 ? w : -w), false)
        requestAnimationFrame(() => slideTo(next, 0, true))
      }
      return
    }
    if (el) slideTo(el, 0, !reduced && dragX !== 0)
  }

  const beginPinch = (a: Touch, b: Touch) => {
    startDist = dist(a.clientX, a.clientY, b.clientX, b.clientY)
    startScale = scale
    startTx = tx
    startTy = ty
    startMidX = localX((a.clientX + b.clientX) / 2)
    startMidY = localY((a.clientY + b.clientY) / 2)
  }

  const onStart = (e: TouchEvent) => {
    // 【再次触摸立刻停】—— 滑行中想按住看清楚，手指落下就该停住（AC-5.15）
    stopFling()
    if (e.touches.length === 2) {
      beginPinch(e.touches[0]!, e.touches[1]!)
      e.preventDefault()
    } else if (e.touches.length === 1) {
      const now = Date.now()
      const t = e.touches[0]!
      if (now - lastTapAt < DOUBLE_TAP_MS) {
        // 双击：1× → 在点下处放大到 2×；已放大 → 复位
        if (scale > 1) reset()
        else zoomAt(localX(t.clientX), localY(t.clientY), TAP_SCALE)
        lastTapAt = 0
        consumed = true
        return
      }
      consumed = false
      moved = 0
      // 手势开始时取一次滚动容器，整段手势都用它
      vpEl = viewport()
      pendingDy = 0
      vy = 0
      // 速度一律用 performance.now()：上面那个 now 是 Date.now()，两个时基不能混
      lastMoveAt = performance.now()
      lastSampleAt = lastMoveAt
      // 记下起点：放大态用来平移画面，1× 用来滚回滚 / 横滑切会话
      panX = t.clientX
      panY = t.clientY
      startX = t.clientX
      startY = t.clientY
      startAt = now
      dragX = 0
      axis = 'none'
    }
  }

  const onMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && startDist > 0) {
      const [a, b] = [e.touches[0]!, e.touches[1]!]
      scale = clampScale(startScale * (dist(a.clientX, a.clientY, b.clientX, b.clientY) / startDist))
      // 锚点：当前双指中点；把手势起点锚下的内容点保持在它下面（并随中点漂移平移）
      const midX = localX((a.clientX + b.clientX) / 2)
      const midY = localY((a.clientY + b.clientY) / 2)
      tx = anchorTranslate(midX, startMidX, startTx, startScale, scale)
      ty = anchorTranslate(midY, startMidY, startTy, startScale, scale)
      apply()
      e.preventDefault()
    } else if (e.touches.length === 1) {
      if (consumed) return // 这一下是双击，不是拖
      const t = e.touches[0]!
      moved = Math.max(moved, dist(t.clientX, t.clientY, startX, startY))
      if (scale > 1) {
        // 放大态：单指平移画面
        tx += t.clientX - panX
        ty += t.clientY - panY
        apply()
      } else {
        // 1× 态：先定方向（前 12px），再一路走到底 —— 中途不改判，否则滚着滚着就切会话了
        if (axis === 'none') {
          const a = lockAxis(t.clientX - startX, t.clientY - startY)
          // 没有可切的目标时横向手势降级成纵向：拖不动，但也不会有假的跟手位移
          axis = a === 'x' && opts.canSwitch?.() === false ? 'y' : a
        }
        if (axis === 'x') {
          dragX = t.clientX - startX
          const el = pageEl()
          if (el && !reducedMotion()) slideTo(el, dragX, false)
        } else if (axis === 'y') {
          // 单指纵向拖 = 滚终端回滚（拖下露出上文）。JS 代劳，见 viewport 注释。
          // 这里【只累加】，落地与采速度都在 flushScroll 里，每帧一次。
          pendingDy += t.clientY - panY
          lastMoveAt = performance.now()
          if (!scrollRaf) scrollRaf = requestAnimationFrame(flushScroll)
        }
      }
      panX = t.clientX
      panY = t.clientY
      // 无论滚没滚到，都吃掉这次拖动，别让它漏给页面变成整页橡皮筋
      e.preventDefault()
    }
  }

  const finish = (cancelled: boolean) => (e: TouchEvent) => {
    startDist = 0
    // 还有手指在屏幕上（双指里松了一根）就不算手势结束
    if (e.touches.length === 0) {
      // 只有【没被吃掉、几乎没动、按得短】才算一次轻点，才有资格参与双击
      const tapped = !consumed && moved < TAP_SLOP_PX && Date.now() - startAt < TAP_MS
      lastTapAt = tapped ? Date.now() : 0
      if (axis === 'x') endSwipe(cancelled)
      else if (axis === 'y') {
        // 最后一段位移也要落地（它可能还在 pendingDy 里等下一帧）
        if (scrollRaf) cancelAnimationFrame(scrollRaf)
        flushScroll()
        if (!cancelled && shouldFling(vy, performance.now() - lastMoveAt, reducedMotion())) startFling()
      }
      vy = 0
      axis = 'none'
      dragX = 0
      consumed = false
    }
    apply()
  }
  const onEnd = finish(false)
  const onCancel = finish(true)

  host.addEventListener('touchstart', onStart, { passive: false })
  host.addEventListener('touchmove', onMove, { passive: false })
  host.addEventListener('touchend', onEnd)
  host.addEventListener('touchcancel', onCancel)

  function zoomAt(mx: number, my: number, to: number) {
    // 从当前状态放大到 to，保持 (mx,my) 下的内容点不动
    tx = anchorTranslate(mx, mx, tx, scale, to)
    ty = anchorTranslate(my, my, ty, scale, to)
    scale = clampScale(to)
    apply()
  }

  function reset() {
    scale = 1
    tx = 0
    ty = 0
    apply()
  }

  return {
    scale: () => scale,
    reset,
    dispose() {
      stopFling()
      if (scrollRaf) cancelAnimationFrame(scrollRaf)
      scrollRaf = 0
      vpEl = null
      host.removeEventListener('touchstart', onStart)
      host.removeEventListener('touchmove', onMove)
      host.removeEventListener('touchend', onEnd)
      host.removeEventListener('touchcancel', onCancel)
      const el = pageEl()
      if (el) slideTo(el, 0, false)
      reset()
    },
  }
}
