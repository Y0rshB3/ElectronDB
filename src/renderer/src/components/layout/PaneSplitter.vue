<script setup lang="ts">
/**
 * Vertical drag handle that resizes an adjacent pane. `side` tells on which
 * side of the handle the resized pane sits.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number
    side: 'left' | 'right'
    min?: number
    max?: number
    label: string
  }>(),
  {
    min: 160,
    max: 560
  }
)
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const clamp = (v: number): number => Math.min(props.max, Math.max(props.min, Math.round(v)))

function onPointerDown(event: PointerEvent): void {
  const startX = event.clientX
  const startWidth = props.modelValue
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture?.(event.pointerId)
  const onMove = (e: PointerEvent): void => {
    const delta = e.clientX - startX
    emit(
      'update:modelValue',
      clamp(props.side === 'left' ? startWidth + delta : startWidth - delta)
    )
  }
  const onUp = (): void => {
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onUp)
    document.body.style.cursor = ''
  }
  document.body.style.cursor = 'col-resize'
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
}

function onKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 40 : 10
  const grow = props.side === 'left' ? 'ArrowRight' : 'ArrowLeft'
  const shrink = props.side === 'left' ? 'ArrowLeft' : 'ArrowRight'
  if (event.key === grow) emit('update:modelValue', clamp(props.modelValue + step))
  else if (event.key === shrink) emit('update:modelValue', clamp(props.modelValue - step))
  else return
  event.preventDefault()
}
</script>

<template>
  <div
    class="pane-splitter"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuenow="modelValue"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    @pointerdown.prevent="onPointerDown"
    @keydown="onKeydown"
  />
</template>

<style scoped>
/* The handle doubles as the 8px gutter between floating panels. */
.pane-splitter {
  width: 8px;
  z-index: 2;
  cursor: col-resize;
  flex: none;
  position: relative;
  outline: none;
}
.pane-splitter::after {
  content: '';
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: 3px;
  width: 2px;
  border-radius: 2px;
  background: var(--nd-accent-gradient-v);
  opacity: 0;
  transition:
    opacity var(--nd-dur) var(--nd-ease),
    box-shadow var(--nd-dur) var(--nd-ease);
}
.pane-splitter:hover::after,
.pane-splitter:active::after {
  opacity: 0.7;
}
.pane-splitter:focus-visible {
  box-shadow: none;
}
.pane-splitter:focus-visible::after {
  opacity: 1;
  box-shadow: 0 0 10px rgba(var(--nd-accent-rgb), 0.5);
}
</style>
