<script setup lang="ts">
/**
 * Inline feedback for a failed Aplicar, shown between the edit bar and the
 * grid so it never covers the rows or the footer. Presentation only.
 */
defineProps<{
  message: string
  /** True when the failed row is known, enabling "Ir a la fila". */
  canLocate: boolean
}>()

const emit = defineEmits<{ locate: []; close: [] }>()
</script>

<template>
  <div class="apply-error" role="alert" data-test="apply-error">
    <v-icon
      icon="mdi-alert-circle-outline"
      size="16"
      class="apply-error__icon"
      aria-hidden="true"
    />
    <div class="apply-error__body">
      <span class="apply-error__message">{{ message }}</span>
      <span class="apply-error__hint">
        Los cambios siguen pendientes: corrígelos y vuelve a aplicar, o descártalos.
      </span>
    </div>
    <v-btn
      v-if="canLocate"
      size="x-small"
      variant="tonal"
      color="error"
      data-test="apply-error-locate"
      @click="emit('locate')"
      >Ir a la fila</v-btn
    >
    <v-btn
      icon="mdi-close"
      size="x-small"
      variant="text"
      aria-label="Cerrar aviso"
      data-test="apply-error-close"
      @click="emit('close')"
    />
  </div>
</template>

<style scoped>
.apply-error {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 0 0 auto;
  padding: 8px 8px 8px 12px;
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
  background: var(--nd-error-soft);
  border-bottom: 1px solid color-mix(in srgb, var(--nd-error) 30%, transparent);
}
.apply-error__icon {
  flex: none;
  margin-top: 1px;
  color: var(--nd-error);
}
.apply-error__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.apply-error__message {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.apply-error__hint {
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
</style>
