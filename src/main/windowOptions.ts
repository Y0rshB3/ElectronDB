import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron'
import type { AppSettings } from '@shared/types'

/**
 * Height of the renderer toolbar (AppToolbar.vue). On Windows/Linux the
 * native window controls overlay is drawn at this height so the min/max/close
 * buttons sit inside the toolbar row.
 */
export const TOOLBAR_HEIGHT = 70

type Theme = AppSettings['theme']

/** Window-controls overlay colours matching the Nebula --nd-bg-app / --nd-text-2 tokens. */
const OVERLAY_COLORS: Record<Theme, { color: string; symbolColor: string }> = {
  dark: { color: '#090c13', symbolColor: '#94a3b8' },
  light: { color: '#f3f5fa', symbolColor: '#475569' }
}

export function titleBarOverlayFor(theme: Theme): TitleBarOverlayOptions {
  return { ...(OVERLAY_COLORS[theme] ?? OVERLAY_COLORS.dark), height: TOOLBAR_HEIGHT }
}

/** Platforms whose title bar is the renderer toolbar plus a native controls overlay. */
export function usesTitleBarOverlay(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}

export interface WindowChromeInput {
  platform: NodeJS.Platform
  theme: Theme
}

/**
 * Title-bar options per OS (pure, so it is unit-testable without electron).
 * - macOS: hidden inset title bar; the traffic lights float over the
 *   toolbar's left gutter (--nd-drag-region in the renderer).
 * - Windows/Linux: hidden title bar with a native window-controls overlay
 *   (minimise, maximise, close) on the right of the toolbar, which keeps
 *   `-webkit-app-region: drag` working and reserves its own area through
 *   the `titlebar-area-*` CSS env variables.
 */
export function windowChromeOptions(input: WindowChromeInput): BrowserWindowConstructorOptions {
  if (!usesTitleBarOverlay(input.platform)) {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
  }
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayFor(input.theme) }
}
