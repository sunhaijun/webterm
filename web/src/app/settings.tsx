/**
 * 设置浮层：主题、终端字号（按形态各存一份）、终端字体（ADR-0023 的清单，只列本机装了的）。
 */
import { Drawer } from '../ui/drawer'
import { GROUP_LABEL, availableFonts, fontStack, type FontGroup } from '../ui/fonts'
import { FONT_MAX, FONT_MIN, type Theme } from '../ui/prefs'

export interface SettingsProps {
  theme: Theme
  fontSize: number
  fontFamily: string
  onTheme(t: Theme): void
  onFontSize(n: number): void
  onFontFamily(id: string): void
  onClose(): void
}

const GROUPS: FontGroup[] = ['default', 'coding', 'platform', 'cjk']

export function Settings(p: SettingsProps) {
  const fonts = availableFonts()
  return (
    <Drawer title="设置" testid="settings" onClose={p.onClose}>
      <label class="settings-row">
        <span class="settings-label">主题</span>
        <select data-testid="theme-select" value={p.theme} onChange={(e) => p.onTheme(e.currentTarget.value as Theme)}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>
      <label class="settings-row">
        <span class="settings-label">终端字号</span>
        <input
          data-testid="font-size"
          type="number"
          inputMode="numeric"
          min={FONT_MIN}
          max={FONT_MAX}
          step={1}
          value={p.fontSize}
          onInput={(e) => p.onFontSize(Number(e.currentTarget.value))}
        />
      </label>
      <label class="settings-row">
        <span class="settings-label">终端字体</span>
        <select data-testid="font-family" value={p.fontFamily} onChange={(e) => p.onFontFamily(e.currentTarget.value)}>
          {GROUPS.map((g) => {
            const items = fonts.filter((c) => c.group === g)
            if (items.length === 0) return null
            const opts = items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))
            return g === 'default' ? (
              opts
            ) : (
              <optgroup key={g} label={GROUP_LABEL[g]}>
                {opts}
              </optgroup>
            )
          })}
        </select>
      </label>
      <div class="settings-row">
        <span class="settings-label">预览</span>
        <span
          class="settings-value font-sample"
          data-testid="font-sample"
          style={{ fontFamily: fontStack(p.fontFamily), fontSize: `${p.fontSize}px` }}
        >
          il1 O0 -&gt;= 中文对齐
        </span>
      </div>
    </Drawer>
  )
}
