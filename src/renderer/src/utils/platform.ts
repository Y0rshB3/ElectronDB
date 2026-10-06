/**
 * Host OS as reported by the preload bridge (process.platform). Test bridges
 * that do not set it behave like macOS, the primary platform.
 */
export function hostPlatform(): string {
  return (typeof window !== 'undefined' && window.electronDB?.platform) || 'darwin'
}

export const isMac = (): boolean => hostPlatform() === 'darwin'

/**
 * Tags <html> with `nd-platform-<os>` (and `nd-window-controls` outside macOS,
 * where the native min/max/close overlay sits on the right of the toolbar) so
 * CSS can lay out the title-bar area per OS.
 */
export function applyPlatformClass(root: HTMLElement = document.documentElement): void {
  const platform = hostPlatform()
  root.classList.add(`nd-platform-${platform}`)
  root.classList.toggle('nd-window-controls', platform !== 'darwin')
}
