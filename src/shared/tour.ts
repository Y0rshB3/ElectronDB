/**
 * Guided tours (welcome tour and «Mostrarme cómo» of the novedades).
 * Plain data so the steps can travel over IPC inside WhatsNewInfo.
 */
export interface TourStep {
  /**
   * `data-tour` value of the element to highlight. With a list, the first one
   * on screen wins (e.g. the filter button of an open table, else the
   * toolbar). Missing or hidden targets: the card is centred, no highlight.
   */
  target?: string | string[]
  /** Short title (a few words). */
  title: string
  /** One or two sentences in Spanish. */
  text: string
}

/** Onboarding state of the profile (tour.json in userData). */
export interface TourState {
  /** Show the welcome tour now: first run of a fresh profile that has not finished or skipped it. */
  showWelcome: boolean
  /** The welcome tour was finished or skipped (or the profile predates the tour). */
  welcomeTourDone: boolean
  /** App version that recorded the last change of this state. */
  tourSeenVersion: string | null
}
