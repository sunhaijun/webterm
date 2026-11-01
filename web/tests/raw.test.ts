/**
 * UT-raw-1: directly inserted text when typing into the terminal (AC-3.14).
 *
 * The on-screen keyboard inserts characters without composition; full-width punctuation
 * on the iOS Chinese keyboard takes this path. xterm 5.5 drops these (it ignores input
 * events after a keydown, and can't read the character from keys with keyCode < 48), so
 * RawIme takes over in beforeinput. See docs/40-frontend/input.md.
 */
import { describe, expect, it, vi } from 'vitest'

import { RawIme } from '../src/keys/raw'

function makeTextarea(): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  document.body.appendChild(el)
  return el
}

/** The beforeinput a browser fires when the on-screen keyboard inserts a character directly. */
function beforeInput(data: string | null, inputType = 'insertText'): InputEvent {
  return new InputEvent('beforeinput', { inputType, data, cancelable: true, bubbles: true })
}

function composition(type: string, data: string): CompositionEvent {
  return new CompositionEvent(type, { data })
}

describe('UT-raw-1 directly inserted text', () => {
  it('sends insertText outside composition itself and calls preventDefault (the character never lands in the textarea)', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    const e = beforeInput('，')
    el.dispatchEvent(e)

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('，')
    // The key point: with preventDefault the character stays out of the textarea, so neither
    // xterm's input path nor the 229 diff path sends it again
    expect(e.defaultPrevented).toBe(true)
  })

  it('sends multi-character insertions (predictive text committing a word) as is', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(beforeInput('，。！'))
    expect(onCommit).toHaveBeenCalledWith('，。！')
  })

  it('leaves composition alone; compositionend handles it', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    const e = beforeInput('n')
    el.dispatchEvent(e)

    expect(onCommit).not.toHaveBeenCalled()
    expect(e.defaultPrevented, 'must never block during composition, or the IME breaks').toBe(false)
  })

  it('ignores inputTypes other than insertText (composition text, deletes and replacements have their own paths)', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    for (const t of ['insertCompositionText', 'deleteContentBackward', 'insertReplacementText', 'insertFromPaste']) {
      const e = beforeInput('x', t)
      el.dispatchEvent(e)
      expect(e.defaultPrevented, t).toBe(false)
    }
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not send insertText with empty data', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(beforeInput(null))
    el.dispatchEvent(beforeInput(''))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('swallows the identical re-send after compositionend (WebKit sends one)', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionupdate', 'nihao'))
    el.dispatchEvent(composition('compositionend', '你好'))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('你好')

    const e = beforeInput('你好')
    el.dispatchEvent(e)
    expect(onCommit, 'the same text must not be sent twice').toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented, 'swallowed: keep it out of the textarea').toBe(true)
  })

  it('still sends punctuation typed right after compositionend (a comma after a word is common)', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionend', '你好'))
    el.dispatchEvent(beforeInput('，'))

    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenNthCalledWith(2, '，')
  })

  it('swallows a character just sent via keypress, since xterm\'s _keyPress already sent it', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'é', bubbles: true }))
    const e = beforeInput('é')
    el.dispatchEvent(e)

    expect(onCommit, 'xterm already sent it; must not send again').not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
  })

  it('sends both of two identical keystrokes; dedup must not eat the second (AC-3.14 / ADR-0020)', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    // Directly inserted characters only arrive through beforeinput (keyCode 0, which xterm
    // ignores on both paths), so nothing else would send the second one; eating it here loses it for good
    el.dispatchEvent(beforeInput('，'))
    el.dispatchEvent(beforeInput('，'))

    expect(onCommit, 'two keystrokes, two sends').toHaveBeenCalledTimes(2)
    expect(onCommit).toHaveBeenNthCalledWith(1, '，')
    expect(onCommit).toHaveBeenNthCalledWith(2, '，')
  })

  it('dedup is one-shot: after suppressing the re-send it disarms, and the same text again is new input', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionend', '哈'))
    expect(onCommit).toHaveBeenCalledTimes(1)

    el.dispatchEvent(beforeInput('哈')) // WebKit's re-send: swallowed
    expect(onCommit).toHaveBeenCalledTimes(1)

    el.dispatchEvent(beforeInput('哈')) // the user typed 哈 again: must be sent
    expect(onCommit, 'after disarming it is new input').toHaveBeenCalledTimes(2)
  })

  it('keypress dedup is one-shot too: two presses, xterm sends both, we send neither', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    // Physical keyboard: each press has its own keypress (already sent by xterm), each arms and suppresses once
    for (let i = 0; i < 2; i++) {
      el.dispatchEvent(new KeyboardEvent('keypress', { key: 'l', bubbles: true }))
      el.dispatchEvent(beforeInput('l'))
    }
    expect(onCommit, 'xterm sent them; we must not add any').not.toHaveBeenCalled()
  })

  it('a keypress for a different character does not affect this one', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    new RawIme(el, { onCommit, onPreview: vi.fn() })

    el.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', bubbles: true }))
    el.dispatchEvent(beforeInput('，'))
    expect(onCommit).toHaveBeenCalledWith('，')
  })

  it('stops handling input after dispose', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    const ime = new RawIme(el, { onCommit, onPreview: vi.fn() })
    ime.dispose()

    const e = beforeInput('，')
    el.dispatchEvent(e)
    expect(onCommit).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })
})

/**
 * UT-raw-2: fallback reset of the composition state (AC-3.3 / ADR-0020).
 *
 * `composing` used to have one exit, compositionend, which isn't guaranteed: switching
 * IMEs or windows, or the OS swallowing the candidate window, can leave composition half
 * done. Stuck at true, terminal input for the session is dead for good (every keydown
 * handler returns early), with no hint to the user except to reload.
 */
describe('UT-raw-2 composition fallback reset', () => {
  const start = (el: HTMLTextAreaElement) => {
    el.dispatchEvent(composition('compositionstart', ''))
    el.dispatchEvent(composition('compositionupdate', 'ni'))
  }

  it('resets on blur: without focus, composition cannot be in progress', () => {
    const el = makeTextarea()
    const onPreview = vi.fn()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview })

    start(el)
    expect(ime.isComposing).toBe(true)

    el.dispatchEvent(new FocusEvent('blur'))

    expect(ime.isComposing, 'input must flow again after blur').toBe(false)
    expect(onPreview).toHaveBeenLastCalledWith('') // the preview is hidden too
  })

  it('resets on a keydown with isComposing=false, which proves composition ended', () => {
    const el = makeTextarea()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })

    start(el)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, isComposing: false }))

    expect(ime.isComposing).toBe(false)
  })

  it('does not reset on composition keys: isComposing=true or keyCode 229 means still composing', () => {
    const el = makeTextarea()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })

    start(el)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', keyCode: 78, isComposing: true }))
    expect(ime.isComposing, 'a key with isComposing=true is part of the composition').toBe(true)

    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229 }))
    expect(ime.isComposing, '229 is a key taken by the IME').toBe(true)
  })

  it('resets before xterm sees the key, so it listens in the capture phase', () => {
    const el = makeTextarea()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview: vi.fn() })
    // xterm listens in the bubble phase (RawIme is constructed after term.open(), so it would run after xterm)
    let composingSeenByXterm: boolean | null = null
    el.addEventListener('keydown', () => (composingSeenByXterm = ime.isComposing))

    start(el)
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 65, isComposing: false }))

    expect(composingSeenByXterm, 'composition must be reset by the time xterm runs, or this key is still lost').toBe(false)
  })

  it('still commits when compositionend arrives after a fallback reset, losing nothing', () => {
    const el = makeTextarea()
    const onCommit = vi.fn()
    const ime = new RawIme(el, { onCommit, onPreview: vi.fn() })

    start(el)
    el.dispatchEvent(new FocusEvent('blur'))
    el.dispatchEvent(composition('compositionend', '你好'))

    expect(onCommit).toHaveBeenCalledWith('你好')
    expect(ime.isComposing).toBe(false)
  })

  it('removes every listener on dispose', () => {
    const el = makeTextarea()
    const onPreview = vi.fn()
    const ime = new RawIme(el, { onCommit: vi.fn(), onPreview })
    ime.dispose()

    start(el)
    el.dispatchEvent(new FocusEvent('blur'))

    expect(onPreview).not.toHaveBeenCalled()
    expect(ime.isComposing).toBe(false)
  })
})
