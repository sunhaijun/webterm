/** Auth gate: shows the pairing page when unpaired, and switches to it when revoked mid-use (AC-1.11 / E2E-15). */
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Gate } from '../src/ui/gate'

async function mount(status: number) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status })))
  const el = document.createElement('div')
  document.body.appendChild(el)
  let revoke: () => void = () => {}
  // act flushes the useEffect (which issues the fetch)
  await act(() => {
    render(
      h(Gate, {
        children: (r: () => void) => {
          revoke = r
          return h('div', { 'data-testid': 'app' }, 'app')
        },
      }),
      el,
    )
  })
  return { el, revoke: () => revoke() }
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
