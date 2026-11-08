/**
 * Hand-drawn UI icons (layout.md, ADR-0037 §3): inline SVG, stroke only, `currentColor`,
 * 1.75px lines with round caps and joins. All share a 14×14 box and are centered
 * geometrically.
 *
 * No Unicode symbols as icons: glyphs like `⚙` differ per platform, some render as color
 * emoji, and their vertical position depends on font metrics (ADR-0035 §3).
 */

/** `size`: the box to draw in (default 14px). Paths always use 14×14 coordinates and the stroke scales with them. */
function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg
      class="icon"
      viewBox="0 0 14 14"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d={d} />
    </svg>
  )
}

export const PlusIcon = () => <Icon d="M7 1.5v11M1.5 7h11" />

export const MinusIcon = () => <Icon d="M1.5 7h11" />

/** Close (ADR-0042 §2): two crossed strokes. 12px on tabs, 16px in sheet headers. */
export const CloseIcon = ({ size = 14 }: { size?: number }) => <Icon d="M3.5 3.5l7 7M10.5 3.5l-7 7" size={size} />

/** Pin (ADR-0042 §2): a pushpin. A bar on top, a body that narrows then flares into a base, and the point. */
export const PinIcon = ({ size = 14 }: { size?: number }) => (
  <Icon d="M4.75 1.75h4.5M5.75 1.75v3.5L3.5 8.25h7L8.25 5.25v-3.5M7 8.25v4" size={size} />
)

/** The menu check mark (shown when Pin is on in the session menu). */
export const CheckIcon = ({ size = 14 }: { size?: number }) => <Icon d="M2.5 7.5l3 3 6-6.5" size={size} />

/**
 * Text page button (left column of the extra keys, ADR-0041 §2): a rounded square missing
 * its top-right corner, with a pencil reaching diagonally out of the gap. One size up from
 * the other icons, 22×22 with a 2px stroke, matching the sessions button's box above it
 * (22px, 2px border, 6px radius). The stroke is centered on the path, so the square's path
 * is inset 1px with radius 5, making the outer edge exactly 22px with a 6px radius.
 */
export const EditIcon = () => (
  <svg
    class="icon"
    viewBox="0 0 22 22"
    width="22"
    height="22"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={EDIT_BOX} />
    <path d={EDIT_PENCIL} />
  </svg>
)

/** The square: from the middle of the top edge counterclockwise to the middle of the right edge, leaving the top-right corner for the pencil. */
export const EDIT_BOX = 'M10 1H6a5 5 0 0 0-5 5v10a5 5 0 0 0 5 5h10a5 5 0 0 0 5-5v-4'

/** The pencil: tip slightly below-left of center, body at 45° toward the top right, rounded end. */
export const EDIT_PENCIL = 'M8 14l.7-3.4 8.3-8.3a2 2 0 0 1 2.7 2.7l-8.3 8.3z'

/**
 * Paperclip, for sending files (ADR-0051), in one stroke: a free end, a long loop, a short
 * loop inside it and the other free end, three wires across, leaning 45° like the pencil.
 * Drawn twice rather than scaled, so each size keeps its stroke: 14×14 at 1.75px in the
 * tab bar next to `+` and ⚙, 22×22 at 2px on the text page across from ✎. The wires are
 * spaced so the inner loop stays open at the small size.
 */
export const PaperclipIcon = () => <Icon d={PAPERCLIP_14} />

export const PaperclipLargeIcon = () => (
  <svg
    class="icon"
    viewBox="0 0 22 22"
    width="22"
    height="22"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d={PAPERCLIP_22} />
  </svg>
)

/** Wires 3 apart, 14 long; loops of radius 3 and 1.5; centered on the box. */
export const PAPERCLIP_14 = 'M7.04 1.79L1.74 7.09A3 3 0 0 0 5.98 11.33L12.7 4.62A1.5 1.5 0 0 0 10.58 2.49L5.63 7.44'

/** Wires 4.75 apart, 21 long; loops of radius 4.75 and 2.375; centered on the box. */
export const PAPERCLIP_22 = 'M10.68 3.14L3.08 10.75A4.75 4.75 0 0 0 9.8 17.46L19.61 7.65A2.375 2.375 0 0 0 16.25 4.29L9.09 11.45'

/** Drag handle (ADR-0040): three horizontal lines. */
export const GripIcon = () => <Icon d="M2 3.5h10M2 7h10M2 10.5h10" />

/** Six-tooth gear: the outline in one stroke and a round hole in the middle (two arcs forming a circle). */
export const GearIcon = () => <Icon d={GEAR} />

/**
 * The gear outline: center (7,7), tip radius 6.1, root radius 4.6, six teeth with tips and
 * roots each taking about half the angle; hole radius 1.9. Computed once at module load.
 */
export const GEAR = gearPath()

export function gearPath(teeth = 6, outer = 6.1, inner = 4.6, hole = 1.9, cx = 7, cy = 7): string {
  const step = (Math.PI * 2) / teeth
  // Per tooth: tip 0.36 of the step, each flank 0.12, root 0.4
  const top = step * 0.36
  const flank = step * 0.12
  const pt = (r: number, a: number) => `${round(cx + r * Math.sin(a))} ${round(cy - r * Math.cos(a))}`
  const parts: string[] = []
  for (let i = 0; i < teeth; i++) {
    const a0 = i * step - top / 2
    const a1 = a0 + top
    const a2 = a1 + flank
    const a3 = a2 + (step - top - 2 * flank)
    const a4 = a3 + flank
    parts.push(`${i === 0 ? 'M' : 'L'}${pt(outer, a0)}`)
    parts.push(`A${outer} ${outer} 0 0 1 ${pt(outer, a1)}`)
    parts.push(`L${pt(inner, a2)}`)
    parts.push(`A${inner} ${inner} 0 0 1 ${pt(inner, a3)}`)
    parts.push(`L${pt(outer, a4)}`)
  }
  parts.push('Z')
  parts.push(`M${round(cx - hole)} ${cy}a${hole} ${hole} 0 1 0 ${round(hole * 2)} 0a${hole} ${hole} 0 1 0 ${round(-hole * 2)} 0Z`)
  return parts.join('')
}

// A function declaration, not a const: `GEAR` calls gearPath() at module load, before the consts below are initialized
function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Frequent input (ADR-0054): a clock face whose rim turns back into an arrow. */
export const HistoryIcon = () => <Icon d="M2.2 4.6A5.25 5.25 0 1 1 1.75 7M1.75 2.25v2.6h2.6M7 4.25V7l1.9 1.25" />

/** Combo keys (ADR-0054): two key caps, one behind the other. */
export const CombosIcon = () => <Icon d="M2.75 1.75h4.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1zM8.25 5.75h3a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-4.5a1 1 0 0 1-1-1v-3" />

/** Show the extra keys (ADR-0056): a keyboard, a rounded body with two rows of keys and a space bar. */
export const KeyboardIcon = () => (
  <Icon d="M2.25 3.75h9.5a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1zM3.75 5.75h.01M6 5.75h.01M8.25 5.75h.01M10.25 5.75h.01M4.75 8h4.5" size={18} />
)
