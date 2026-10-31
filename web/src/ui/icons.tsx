/**
 * 界面上自己画的图标（layout.md §图标，ADR-0037 §3）：内联 SVG，只描边不填充，
 * `currentColor`，线宽 1.75px，端点与拐角都是圆的。14×14 同一个框，按几何中心对齐。
 *
 * 不用 Unicode 符号当图标：`⚙` 之类各平台字形不同，有的渲染成彩色 emoji，
 * 上下位置也随字体度量变（ADR-0035 §3）。
 */

const SIZE = 14

function Icon({ d, size = SIZE }: { d: string; size?: number }) {
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

/** 拖动柄（ADR-0040）：三条横线。 */
export const GripIcon = () => <Icon d="M2 3.5h10M2 7h10M2 10.5h10" />

/** 六齿齿轮：外轮廓一笔画完，中间一个圆孔（两段弧画成整圆）。 */
export const GearIcon = () => <Icon d={GEAR} />

/**
 * 齿轮的轮廓：中心 (7,7)，齿顶半径 6.1、齿根半径 4.6，六个齿，齿顶与齿根各占约一半角度；
 * 圆孔半径 1.9。模块加载时算一次。
 */
export const GEAR = gearPath()

export function gearPath(teeth = 6, outer = 6.1, inner = 4.6, hole = 1.9, cx = 7, cy = 7): string {
  const step = (Math.PI * 2) / teeth
  // 每个齿：齿顶占 step 的 0.36，两侧斜边各 0.12，齿根占 0.4
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

// 函数声明而不是 const：`GEAR` 在模块加载时就调 gearPath()，那时下面的 const 还没初始化
function round(n: number): number {
  return Math.round(n * 100) / 100
}
