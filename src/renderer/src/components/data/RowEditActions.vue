<script setup lang="ts">
/**
 * Row editing actions (add, delete, NULL, pending count, discard, apply)
 * shared by the table data view and editable query results. Presentation
 * only: the parent owns the state (useRowEditor) and handles the events.
 * Renders with `display: contents` so it lays out inside the parent bar.
 *
 * The parent bar should carry `nd-viewbar--rowedit` (viewChrome.css): it is
 * the size container that collapses the secondary buttons to icons when the
 * panel is narrow, so Aplicar always stays visible with its label.
 */
defineProps<{
  canAdd: boolean
  canDelete: boolean
  canSetNull: boolean
  pending: number
  applying: boolean
}>()

const emit = defineEmits<{
  add: []
  delete: []
  null: []
  discard: []
  apply: []
}>()
</script>

<template>
  <div class="row-edit-actions">
    <v-btn
      prepend-icon="mdi-plus"
      size="small"
      class="row-edit-actions__btn"
      :disabled="!canAdd"
      aria-label="Añadir fila"
      title="Añadir fila"
      data-test="add-row"
      @click="emit('add')"
    >
      <span class="row-edit-actions__label">Añadir fila</span>
    </v-btn>
    <v-btn
      prepend-icon="mdi-minus"
      size="small"
      class="row-edit-actions__btn"
      :disabled="!canDelete"
      aria-label="Eliminar filas seleccionadas"
      title="Eliminar filas seleccionadas"
      data-test="delete-rows"
      @click="emit('delete')"
    >
      <span class="row-edit-actions__label">Eliminar</span>
    </v-btn>
    <v-btn
      prepend-icon="mdi-null"
      size="small"
      class="row-edit-actions__btn"
      :disabled="!canSetNull"
      aria-label="Poner NULL en la celda activa"
      title="Poner NULL en la celda activa"
      data-test="set-null"
      @click="emit('null')"
    >
      <span class="row-edit-actions__label">NULL</span>
    </v-btn>
    <span class="nd-viewbar__spacer" />
    <span
      v-if="pending > 0"
      class="nd-status-pill nd-status-pill--warning row-edit-actions__pending"
      role="status"
      :title="`${pending} cambio(s) pendiente(s)`"
      data-test="pending"
    >
      <span class="nd-status-pill__dot" aria-hidden="true" />
      {{ pending }}
      <span class="row-edit-actions__pending-text">cambio(s) pendiente(s)</span>
    </span>
    <span class="row-edit-actions__commit">
      <v-btn
        prepend-icon="mdi-close"
        size="small"
        class="row-edit-actions__btn"
        :disabled="pending === 0 || applying"
        aria-label="Descartar cambios"
        title="Descartar cambios"
        data-test="discard"
        @click="emit('discard')"
      >
        <span class="row-edit-actions__label">Descartar</span>
      </v-btn>
      <v-btn
        prepend-icon="mdi-check"
        size="small"
        color="primary"
        variant="flat"
        :disabled="pending === 0"
        :loading="applying"
        title="Aplicar cambios (Cmd+S)"
        data-test="apply"
        @click="emit('apply')"
      >
        Aplicar
      </v-btn>
    </span>
  </div>
</template>

<style scoped src="./viewChrome.css"></style>
<style scoped>
.row-edit-actions {
  display: contents;
}
.row-edit-actions__pending {
  flex: none;
  margin-right: 6px;
}
/* Discard + Apply never split across lines; if the bar wraps they stay right-aligned. */
.row-edit-actions__commit {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  margin-left: auto;
}

/* Narrow panels: secondary actions become icon buttons (names stay in aria-label/title). */
@container rowedit (max-width: 860px) {
  .row-edit-actions__label {
    display: none;
  }
  .row-edit-actions__btn {
    min-width: 0;
    padding-inline: 8px;
  }
  .row-edit-actions__btn :deep(.v-btn__prepend) {
    margin-inline: 0;
  }
  /* Only the count stays visible; the text remains for screen readers. */
  .row-edit-actions__pending-text {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
