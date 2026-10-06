import type { Directive } from 'vue'

/**
 * Keeps the end of a long path visible in a PathPicker field while it is not
 * focused, so the last folders (the part that matters) are shown instead of the
 * leading `/Volumes/...` segments. When the path overflows, the host gets the
 * `nd-path-field--clipped` class, which fades the left edge to signal that the
 * start is hidden. Purely presentational: the input value is never touched.
 *
 * Usage: `<PathPicker v-path-tail="model" class="nd-path-field" ... />`
 * (the binding value is only used to re-run the sync when the path changes).
 */

interface PathTailState {
  input: HTMLInputElement | null
  sync: () => void
  observer: ResizeObserver | null
  frame: number
}

const states = new WeakMap<HTMLElement, PathTailState>()

function schedule(state: PathTailState): void {
  if (typeof requestAnimationFrame !== 'function') {
    state.sync()
    return
  }
  cancelAnimationFrame(state.frame)
  state.frame = requestAnimationFrame(state.sync)
}

export const vPathTail: Directive<HTMLElement, unknown> = {
  mounted(el) {
    const input = el.querySelector('input')
    const state: PathTailState = {
      input,
      observer: null,
      frame: 0,
      sync: () => {
        if (!input) return
        const clipped = input.scrollWidth > input.clientWidth + 1
        el.classList.toggle('nd-path-field--clipped', clipped && document.activeElement !== input)
        if (document.activeElement === input) return
        input.scrollLeft = input.scrollWidth
      }
    }
    states.set(el, state)
    if (!input) return
    input.addEventListener('blur', state.sync)
    input.addEventListener('focus', state.sync)
    if (typeof ResizeObserver === 'function') {
      state.observer = new ResizeObserver(() => schedule(state))
      state.observer.observe(input)
    }
    schedule(state)
  },
  updated(el, binding) {
    if (binding.value === binding.oldValue) return
    const state = states.get(el)
    if (state) schedule(state)
  },
  beforeUnmount(el) {
    const state = states.get(el)
    if (!state) return
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.frame)
    state.observer?.disconnect()
    state.input?.removeEventListener('blur', state.sync)
    state.input?.removeEventListener('focus', state.sync)
    states.delete(el)
  }
}
