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
