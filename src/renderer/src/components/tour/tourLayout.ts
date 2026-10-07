/** Pure geometry and target lookup of the guided tour (kept apart for tests). */

export interface Box {
  top: number
  left: number
  width: number
  height: number
}

export type Placement = 'bottom' | 'top' | 'right' | 'left' | 'center'

export interface CardPosition {
  top: number
  left: number
  placement: Placement
}

/** Space kept between the highlighted element and the card, and from the window edges. */
export const TOUR_GAP = 14
export const TOUR_EDGE = 12
/** Padding of the highlight ring around the target. */
export const SPOTLIGHT_PAD = 6

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, Math.max(min, max)))

/**
 * Where the card goes: below the target, else above, right, left; centred
 * when there is no target or no side has room. Always inside the viewport.
 */
export function placeCard(
  target: Box | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number }
): CardPosition {
  const centre = (): CardPosition => ({
    top: Math.max(TOUR_EDGE, Math.round((viewport.height - card.height) / 2)),
    left: Math.max(TOUR_EDGE, Math.round((viewport.width - card.width) / 2)),
    placement: 'center'
  })
  if (!target) return centre()
  const maxLeft = viewport.width - card.width - TOUR_EDGE
  const maxTop = viewport.height - card.height - TOUR_EDGE
  const alignedLeft = clamp(target.left + target.width / 2 - card.width / 2, TOUR_EDGE, maxLeft)
  const alignedTop = clamp(target.top + target.height / 2 - card.height / 2, TOUR_EDGE, maxTop)
  const below = target.top + target.height + TOUR_GAP
  if (below + card.height + TOUR_EDGE <= viewport.height)
    return { top: Math.round(below), left: Math.round(alignedLeft), placement: 'bottom' }
  const above = target.top - TOUR_GAP - card.height
  if (above >= TOUR_EDGE)
    return { top: Math.round(above), left: Math.round(alignedLeft), placement: 'top' }
  const right = target.left + target.width + TOUR_GAP
  if (right + card.width + TOUR_EDGE <= viewport.width)
    return { top: Math.round(alignedTop), left: Math.round(right), placement: 'right' }
  const left = target.left - TOUR_GAP - card.width
  if (left >= TOUR_EDGE)
    return { top: Math.round(alignedTop), left: Math.round(left), placement: 'left' }
  return centre()
}

/** The highlight box around a target, padded and kept inside the viewport. */
export function spotlightBox(target: Box, viewport: { width: number; height: number }): Box {
  const top = Math.max(0, target.top - SPOTLIGHT_PAD)
  const left = Math.max(0, target.left - SPOTLIGHT_PAD)
  const bottom = Math.min(viewport.height, target.top + target.height + SPOTLIGHT_PAD)
  const right = Math.min(viewport.width, target.left + target.width + SPOTLIGHT_PAD)
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** CSS selector of a `data-tour` name (quotes escaped). */
export function tourSelector(name: string): string {
  return `[data-tour="${name.replace(/["\\]/g, '\\$&')}"]`
}

/**
 * First on-screen element among the `data-tour` names, or null. Hidden
 * elements (display:none, zero size, detached) do not count.
 */
export function findTourTarget(
  target: string | string[] | undefined,
  root: ParentNode = document
): HTMLElement | null {
  if (!target) return null
  const names = Array.isArray(target) ? target : [target]
  for (const name of names) {
    for (const el of root.querySelectorAll<HTMLElement>(tourSelector(name))) {
      if (el.getClientRects().length === 0) continue
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return el
    }
  }
  return null
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}
