/** Auth gate: shows the pairing page when unpaired, and switches to it when revoked mid-use (AC-1.11 / E2E-15). */
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Gate } from '../src/ui/gate'

async function mount(status: number, body: unknown = {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status, json: () => Promise.resolve(body) })))
  const el = document.createElement('div')
  document.body.appendChild(el)
  let revoke: () => void = () => {}
  let signedOut: () => void = () => {}
  // act flushes the useEffect (which issues the fetch)
  await act(() => {
    render(
      h(Gate, {
        children: (r: () => void, s: () => void) => {
          revoke = r
          signedOut = s
          return h('div', { 'data-testid': 'app' }, 'app')
        },
      }),
      el,
    )
  })
  return { el, revoke: () => revoke(), signedOut: () => signedOut() }
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)))

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Gate', () => {
  it('renders children when paired', async () => {
    const { el } = await mount(200)
    await settle()
    expect(el.querySelector('[data-testid="app"]')).not.toBeNull()
  })

  it('shows the pairing page without the revoked notice when unpaired (401)', async () => {
    const { el } = await mount(401)
    await settle()
    expect(el.querySelector('[data-testid="unpaired"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="revoked"]')).toBeNull()
  })

  // A page opened after the revocation gets code "revoked" with its 401 (AC-1.11)
  it('says the device was revoked when the 401 carries code "revoked"', async () => {
    const { el } = await mount(401, { code: 'revoked', message: 'This device has been revoked' })
    await settle()
    expect(el.querySelector('[data-testid="unpaired"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="revoked"]')?.textContent).toContain('This device has been revoked')
  })

  it('signing out shows the pairing page with "Signed out" (AC-1.22)', async () => {
    const { el, signedOut } = await mount(200)
    await settle()
    await act(() => signedOut())
    expect(el.querySelector('[data-testid="app"]')).toBeNull()
    expect(el.querySelector('[data-testid="signed-out"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="revoked"]')).toBeNull()
  })

  it('unmounts children when revoked mid-use and shows the pairing page with the revoked notice', async () => {
    const { el, revoke } = await mount(200)
    await settle()
    await act(() => revoke())
    expect(el.querySelector('[data-testid="app"]')).toBeNull()
    expect(el.querySelector('[data-testid="unpaired"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="revoked"]')?.textContent).toContain('This device has been revoked')
    expect(el.querySelector('a[href="/pair"]')).not.toBeNull()
  })
})

// UT-connbanner-1: the gate draws the app's frame with the connection banner while it
// checks pairing, and keeps retrying an unreachable agent (ADR-0049 §2, §3).
describe('Gate startup banner', () => {
  it('shows "Connecting…" in the banner while checking, not page text', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const el = document.createElement('div')
    document.body.appendChild(el)
    await act(() => {
      render(h(Gate, { children: () => h('div', { 'data-testid': 'app' }) }), el)
    })
    expect(el.querySelector('.app .stage [data-testid="conn-banner"]')?.textContent).toBe('Connecting…')
    expect(el.textContent).not.toContain('Checking pairing')
  })

  it('says it can\'t reach the agent in the banner, retries, and gets through without a reload', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(() => (++calls < 3 ? Promise.reject(new Error('offline')) : Promise.resolve({ status: 200, json: () => Promise.resolve({}) }))),
    )
    const el = document.createElement('div')
    document.body.appendChild(el)
    await act(() => {
      render(h(Gate, { children: () => h('div', { 'data-testid': 'app' }) }), el)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(el.querySelector('[data-testid="offline"] [data-testid="conn-text"]')?.textContent).toBe("Can't reach the agent · retrying")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(calls).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(el.querySelector('[data-testid="app"]'), 'got through on the third try').not.toBeNull()
    vi.useRealTimers()
  })
})
