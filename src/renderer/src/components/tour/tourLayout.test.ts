import { afterEach, describe, expect, it } from 'vitest'
import { findTourTarget, placeCard, spotlightBox, TOUR_EDGE, TOUR_GAP } from './tourLayout'

const vp = { width: 1200, height: 800 }
const card = { width: 360, height: 180 }

describe('placeCard', () => {
  it('centres the card when there is no target', () => {
    expect(placeCard(null, card, vp)).toEqual({ top: 310, left: 420, placement: 'center' })
  })

  it('goes below the target, horizontally centred on it', () => {
    const pos = placeCard({ top: 10, left: 500, width: 80, height: 40 }, card, vp)
    expect(pos).toEqual({ top: 50 + TOUR_GAP, left: 360, placement: 'bottom' })
  })

  it('goes above when there is no room below', () => {
    const pos = placeCard({ top: 700, left: 500, width: 80, height: 60 }, card, vp)
    expect(pos.placement).toBe('top')
    expect(pos.top).toBe(700 - TOUR_GAP - 180)
  })

  it('goes to the right of a tall element (the connection tree)', () => {
    const pos = placeCard({ top: 60, left: 8, width: 260, height: 730 }, card, vp)
    expect(pos.placement).toBe('right')
    expect(pos.left).toBe(268 + TOUR_GAP)
  })

  it('stays inside the viewport near the edges', () => {
    const pos = placeCard({ top: 10, left: 1150, width: 40, height: 30 }, card, vp)
    expect(pos.left).toBe(vp.width - card.width - TOUR_EDGE)
    const left = placeCard({ top: 10, left: 0, width: 40, height: 30 }, card, vp)
    expect(left.left).toBe(TOUR_EDGE)
  })

  it('centres when the target fills the window', () => {
    expect(placeCard({ top: 0, left: 0, width: 1200, height: 800 }, card, vp).placement).toBe(
      'center'
    )
  })
})

describe('spotlightBox', () => {
  it('pads the target and clips it to the viewport', () => {
    expect(spotlightBox({ top: 2, left: 100, width: 50, height: 20 }, vp)).toEqual({
      top: 0,
      left: 94,
      width: 62,
      height: 28
    })
  })
})

describe('findTourTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function el(name: string, visible: boolean): HTMLElement {
    const node = document.createElement('div')
    node.setAttribute('data-tour', name)
    const rect = visible
      ? { top: 1, left: 1, width: 10, height: 10, right: 11, bottom: 11, x: 1, y: 1 }
      : { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 }
    node.getBoundingClientRect = () => rect as DOMRect
    node.getClientRects = () => (visible ? [rect] : []) as unknown as DOMRectList
    document.body.appendChild(node)
    return node
  }

  it('returns null without a target or when nothing is on screen', () => {
    expect(findTourTarget(undefined)).toBeNull()
    el('hidden', false)
    expect(findTourTarget('hidden')).toBeNull()
    expect(findTourTarget('missing')).toBeNull()
  })

  it('takes the first visible element of the list', () => {
    el('table-filter', false)
    const toolbar = el('toolbar-objects', true)
    expect(findTourTarget(['table-filter', 'toolbar-objects'])).toBe(toolbar)
    const filter = el('table-filter', true)
    expect(findTourTarget(['table-filter', 'toolbar-objects'])).toBe(filter)
  })
})
