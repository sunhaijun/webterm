/**
 * The system Back button for sheets (session-ux.md, ADR-0059 §1). Each sheet that wants
 * Back pushes one history entry while it is open; Back closes only the top sheet.
 *
 * A sheet closed any other way must take its entry away again, or entries pile up and Back
 * in an Android PWA would exit the app. That takes a `history.go(-n)`, whose `popstate`
 * must not close the next sheet down, so it is counted and skipped. Sheets closed together
 * (Send to session closes a file and the list in one render) are removed with one
 * `go(-n)`: two traversals requested back to back aren't reliably both performed.
 */

export interface HistoryLike {
  pushState(data: unknown, unused: string): void
  go(delta: number): void
}

interface Entry {
  close(): void
  popped: boolean
}

export class BackStack {
  private readonly stack: Entry[] = []
  /** Entries to remove at the end of this task. */
  private pending = 0
  /** popstate events we caused, still to arrive. */
  private ours = 0

  constructor(
    private readonly history: HistoryLike,
    // Wrapped: queueMicrotask called as a method of this object throws "Illegal invocation"
    private readonly defer: (fn: () => void) => void = (fn) => queueMicrotask(fn),
  ) {}

  /** A sheet opened: push its entry. Call the returned function when it closes, however it closed. */
  push(close: () => void): () => void {
    this.history.pushState({ webtermDrawer: true }, '')
    const entry: Entry = { close, popped: false }
    this.stack.push(entry)
    return () => {
      const i = this.stack.indexOf(entry)
      if (i >= 0) this.stack.splice(i, 1)
      if (entry.popped) return
      if (this.pending++ === 0) {
        this.defer(() => {
          const n = this.pending
          this.pending = 0
          this.ours++
          this.history.go(-n)
        })
      }
    }
  }

  /** `popstate`: ours is skipped; otherwise it was Back, and the top sheet closes. */
  onPop(): void {
    if (this.ours > 0) {
      this.ours--
      return
    }
    const top = this.stack[this.stack.length - 1]
    if (!top) return
    top.popped = true
    top.close()
  }

  get depth(): number {
    return this.stack.length
  }
}

let shared: BackStack | null = null

/** The page's one stack, listening to `popstate` from first use. */
export function backStack(): BackStack {
  if (!shared) {
    const s = new BackStack(window.history)
    window.addEventListener('popstate', () => s.onPop())
    shared = s
  }
  return shared
}
