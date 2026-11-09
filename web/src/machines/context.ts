/**
 * What the app gets from the page about machines (ADR-0062): the list, the current one, and
 * the actions that change them. The page (`root.tsx`) owns all of it; the app only shows the
 * machine button and the sheets.
 */
import type { TextPages } from '../keys/textpage'

/** The Add sheet opened by the page itself: a machine signed this device out (ADR-0062 §9). */
export interface Repair {
  origin: string
  message: string
}

export interface MachineCtx {
  /** The page's own origin. */
  own: string
  /** The machine the app talks to. */
  current: string
  /** The other machines, in the order added. */
  list: string[]
  /** Display names for `own` and every listed machine. */
  names: Map<string, string>
  /** The current machine's text pages and drafts, kept per machine (ADR-0062 §7). */
  pages: TextPages
  repair: Repair | null
  clearRepair(): void
  switchTo(origin: string): void
  /** Pairs with `origin` and switches to it; resolves to null, or the reason it failed. */
  add(origin: string, digits: string): Promise<string | null>
  /** Signs out there and drops it; `force` drops it without asking the machine. */
  remove(origin: string, force: boolean): Promise<'done' | 'unreachable' | 'failed'>
  /** Signs out of every other machine, then the page's own; resolves to the own machine's HTTP status. */
  signOut(): Promise<number>
}
