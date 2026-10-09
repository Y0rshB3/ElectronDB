import { afterEach, describe, expect, it, vi } from 'vitest'
import { hideSplash } from './splash'

describe('startup splash', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('fades out after the minimum time and is then removed', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="splash"></div>'
    hideSplash(document, 100, 600)
    const el = document.getElementById('splash')!
    vi.advanceTimersByTime(499)
    expect(el.classList.contains('splash--hide')).toBe(false)
    vi.advanceTimersByTime(1)
    expect(el.classList.contains('splash--hide')).toBe(true)
    vi.advanceTimersByTime(400)
    expect(document.getElementById('splash')).toBeNull()
  })

  it('does nothing without a splash', () => {
    expect(() => hideSplash(document, 0, 0)).not.toThrow()
  })
})
