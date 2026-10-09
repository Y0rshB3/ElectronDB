/**
 * Startup splash (the #splash block in index.html): fades out once the app has
 * mounted, after a short minimum so a fast start does not flash it.
 */
export const SPLASH_MIN_MS = 600

export function hideSplash(
  doc: Document = document,
  now: number = performance.now(),
  minMs: number = SPLASH_MIN_MS
): void {
  const el = doc.getElementById('splash')
  if (!el) return
  const fade = (): void => {
    el.classList.add('splash--hide')
    // Removed after the CSS fade (0.35 s); a timer, so it also goes when transitions are off.
    setTimeout(() => el.remove(), 400)
  }
  setTimeout(fade, Math.max(0, minMs - now))
}
