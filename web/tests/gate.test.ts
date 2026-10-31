/** 认证闸门：未配对显示引导页；用着用着被吊销也换成引导页（AC-1.11 / E2E-15）。 */
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Gate } from '../src/ui/gate'

async function mount(status: number) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status })))
  const el = document.createElement('div')
  document.body.appendChild(el)
  let revoke: () => void = () => {}
  // act：把 useEffect（里面发 fetch）冲出来
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
  it('已配对：渲染 children', async () => {
    const { el } = await mount(200)
    await settle()
    expect(el.querySelector('[data-testid="app"]')).not.toBeNull()
  })

  it('未配对（401）：配对引导页，没有「已被吊销」', async () => {
    const { el } = await mount(401)
    await settle()
    expect(el.querySelector('[data-testid="unpaired"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="revoked"]')).toBeNull()
  })

  it('用着用着被吊销：children 卸掉，换成配对引导页并写明「此设备已被吊销」', async () => {
    const { el, revoke } = await mount(200)
    await settle()
    await act(() => revoke())
    expect(el.querySelector('[data-testid="app"]')).toBeNull()
    expect(el.querySelector('[data-testid="unpaired"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="revoked"]')?.textContent).toContain('此设备已被吊销')
    expect(el.querySelector('a[href="/pair"]')).not.toBeNull()
  })
})
