/**
 * 设置（layout.md §设置，ADR-0037）：只有两项 —— 主题三选一、终端字号 `−` / `+`。
 * 改了立刻生效，没有「保存」，不写说明文字。
 *
 * 字号不用数字输入框：手机上一点就弹数字键盘。
 */
import { Drawer } from '../ui/drawer'
import { MinusIcon, PlusIcon } from '../ui/icons'
import { FONT_MAX, FONT_MIN, type Theme } from '../ui/prefs'

export interface SettingsProps {
  theme: Theme
  fontSize: number
  onTheme(t: Theme): void
  onFontSize(px: number): void
  onClose(): void
}

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
]

export function Settings(p: SettingsProps) {
  return (
    <Drawer title="设置" testid="settings" variant="settings" onClose={p.onClose}>
      <div class="settings-row">
        <span class="settings-label" id="settings-theme">
          主题
        </span>
        <div class="segmented" role="radiogroup" aria-labelledby="settings-theme">
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.id}
              role="radio"
              data-testid={`theme-${t.id}`}
              aria-checked={p.theme === t.id ? 'true' : 'false'}
              onClick={() => p.onTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-label" id="settings-font">
          终端字号
        </span>
        <div class="stepper" role="group" aria-labelledby="settings-font">
          <button
            type="button"
            data-testid="font-dec"
            aria-label="减小字号"
            disabled={p.fontSize <= FONT_MIN}
            onClick={() => p.onFontSize(p.fontSize - 1)}
          >
            <MinusIcon />
          </button>
          <span class="stepper-value" data-testid="font-size" aria-live="polite">
            {p.fontSize}
          </span>
          <button
            type="button"
            data-testid="font-inc"
            aria-label="增大字号"
            disabled={p.fontSize >= FONT_MAX}
            onClick={() => p.onFontSize(p.fontSize + 1)}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
    </Drawer>
  )
}
