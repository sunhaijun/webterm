/**
 * Settings (layout.md, ADR-0037): just two items, a three-way theme choice and the
 * terminal font size `−` / `+`. Changes apply immediately; no Save button, no help text.
 * Below them, one action: sign out this device (ADR-0048), which asks first.
 *
 * Font size is not a number input: on phones that pops up the numeric keyboard.
 */
import { Drawer } from '../ui/drawer'
import { MinusIcon, PlusIcon } from '../ui/icons'
import { FONT_MAX, FONT_MIN, type Theme } from '../ui/prefs'

export interface SettingsProps {
  theme: Theme
  fontSize: number
  onTheme(t: Theme): void
  onFontSize(px: number): void
  onSignOut(): void
  onClose(): void
}

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

export function Settings(p: SettingsProps) {
  return (
    <Drawer title="Settings" testid="settings" variant="settings" onClose={p.onClose}>
      <div class="settings-row">
        <span class="settings-label" id="settings-theme">
          Theme
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
          Font size
        </span>
        <div class="stepper" role="group" aria-labelledby="settings-font">
          <button
            type="button"
            data-testid="font-dec"
            aria-label="Decrease font size"
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
            aria-label="Increase font size"
            disabled={p.fontSize >= FONT_MAX}
            onClick={() => p.onFontSize(p.fontSize + 1)}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <div class="settings-row">
        <button type="button" class="drawer-btn danger" data-testid="sign-out" onClick={p.onSignOut}>
          Sign out this device
        </button>
      </div>
    </Drawer>
  )
}
