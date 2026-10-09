import type { JobTask } from '@shared/types'

/**
 * Drag payload between the «Añadir pasos» browser and the step sequence of
 * the job editor. dataTransfer only carries strings, so the steps being
 * dragged wait here until the sequence takes them on drop.
 */
export const STEP_DRAG_TYPE = 'application/x-vortaq-job-step'
export const ADD_DRAG_TYPE = 'application/x-vortaq-job-add'

let pending: (() => JobTask[]) | null = null

export function startAddDrag(build: () => JobTask[]): void {
  pending = build
}

/** Steps of the current browser drag (built now, against the latest job), or []. */
export function takeAddDrag(): JobTask[] {
  const build = pending
  pending = null
  return build ? build() : []
}

export function endAddDrag(): void {
  pending = null
}
