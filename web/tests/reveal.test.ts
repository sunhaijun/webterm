/** UT-reveal-1：把选中的会话滚进可视区（AC-4.9）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { revealActive, scrollParent } from '../src/ui/reveal'

function rect(el: HTMLElement, top: number, bottom: number): void {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top }) as DOMRect
}

/** 一个能滚的容器（top 0 / bottom 100）加一行会话。 */
function list(itemTop: number, itemBottom: number) {
  document.body.innerHTML = ''
  const box = document.createElement('div')
  box.style.overflowY = 'auto'
  const item = document.createElement('div')
  box.appendChild(item)
  document.body.appendChild(box)
  rect(box, 0, 100)
  rect(item, itemTop, itemBottom)
  item.scrollIntoView = vi.fn()
  return { box, item }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('滚进可视区', () => {
  it('整条已经可见 → 什么都不做（别抖）', () => {
    const { item } = list(20, 56)
    revealActive(item)
    expect(item.scrollIntoView).not.toHaveBeenCalled()
  })

  it('贴着上下边缘也算可见', () => {
    const { item } = list(0, 100)
    revealActive(item)
    expect(item.scrollIntoView).not.toHaveBeenCalled()
  })

  it('下缘超出 → 滚，且是 nearest、不带 smooth', () => {
    const { item } = list(80, 130)
    revealActive(item)
    expect(item.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('上缘超出 → 同样滚', () => {
    const { item } = list(-30, 6)
    revealActive(item)
    expect(item.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('找不到可滚动祖先时保底滚一次（浮层里的列表结构可能不一样）', () => {
    document.body.innerHTML = ''
    const item = document.createElement('div')
    document.body.appendChild(item)
    item.scrollIntoView = vi.fn()
    revealActive(item)
    expect(item.scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('没有元素 / 环境没有 scrollIntoView 都不能抛', () => {
    expect(() => revealActive(null)).not.toThrow()
    const bare = document.createElement('div')
    // @ts-expect-error 故意抹掉，jsdom 之外的环境未必有
    bare.scrollIntoView = undefined
    expect(() => revealActive(bare)).not.toThrow()
  })
})

describe('scrollParent', () => {
  it('找最近的 overflow-y: auto / scroll 祖先', () => {
    document.body.innerHTML = ''
    const outer = document.createElement('div')
    outer.style.overflowY = 'scroll'
    const mid = document.createElement('div')
    const item = document.createElement('div')
    mid.appendChild(item)
    outer.appendChild(mid)
    document.body.appendChild(outer)
    expect(scrollParent(item)).toBe(outer)
  })

  it('都不滚就是 null', () => {
    document.body.innerHTML = ''
    const item = document.createElement('div')
    document.body.appendChild(item)
    expect(scrollParent(item)).toBeNull()
  })
})
