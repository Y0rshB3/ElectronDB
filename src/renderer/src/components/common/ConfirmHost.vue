<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useUiStore } from '@renderer/stores/ui'

/** Renders the single global confirmation requested through ui.ask(). */
const ui = useUiStore()
const typed = ref('')

const request = computed(() => ui.confirm)
const needsTyping = computed(() => !!request.value.requireTyped)
const canConfirm = computed(
  () => !needsTyping.value || typed.value.trim() === request.value.requireTyped
)

const open = computed({
  get: () => ui.confirm.open,
  set: (value: boolean) => {
    if (!value && ui.confirm.open) ui.answer(false)
  }
})

watch(
  () => ui.confirm.open,
  (isOpen) => {
    if (isOpen) typed.value = ''
  }
)

function confirm(): void {
  if (canConfirm.value) ui.answer(true)
}
</script>

<template>
  <v-dialog
    v-model="open"
    max-width="500"
    :persistent="request.production"
    data-test="confirm-dialog"
  >
    <v-card
      class="confirm-host"
      :class="{ 'confirm-host--production nd-danger-card': request.production }"
      role="alertdialog"
      :aria-label="request.title"
    >
      <div class="confirm-host__head">
        <span
          class="nd-icon-badge"
          :class="{ 'nd-icon-badge--danger': request.production || request.color === 'error' }"
          aria-hidden="true"
        >
          <v-icon
            :icon="
              request.production
                ? 'mdi-alert-octagon-outline'
                : request.notice
                  ? 'mdi-information-outline'
                  : 'mdi-help-circle-outline'
            "
            size="19"
          />
        </span>
        <h2 class="confirm-host__title">{{ request.title }}</h2>
      </div>
      <div class="confirm-host__body">
        <div v-if="request.production" class="confirm-host__banner" data-test="confirm-production">
          <v-icon icon="mdi-shield-alert-outline" size="16" />
          <span>Conexión de PRODUCCIÓN</span>
        </div>
        <p class="confirm-host__message" data-test="confirm-message">{{ request.message }}</p>
        <pre v-if="request.details" class="confirm-host__details">{{ request.details }}</pre>
        <v-text-field
          v-if="needsTyping"
          v-model="typed"
          class="mt-4"
          :label="`Escribe «${request.requireTyped}» para confirmar`"
          autofocus
          autocomplete="off"
          spellcheck="false"
          data-test="confirm-typed"
          @keydown.enter.prevent="confirm"
        />
      </div>
      <v-card-actions class="confirm-host__actions">
        <v-spacer />
        <v-btn
          v-if="!request.notice"
          variant="text"
          data-test="confirm-cancel"
          @click="ui.answer(false)"
          >Cancelar</v-btn
        >
        <v-btn
          :color="request.color ?? 'primary'"
          variant="flat"
          :disabled="!canConfirm"
          :autofocus="!needsTyping"
          data-test="confirm-ok"
          @click="confirm"
          >{{ request.confirmText ?? 'Aceptar' }}</v-btn
        >
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.confirm-host__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 22px 4px;
}
.confirm-host__title {
  font-size: var(--nd-fs-title);
  font-weight: var(--nd-fw-heading);
  line-height: 1.35;
  color: var(--nd-text);
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.confirm-host__body {
  padding: 10px 22px 18px 70px;
  font-size: var(--nd-fs-base);
  color: var(--nd-text-2);
}
.confirm-host__banner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: var(--nd-radius-control);
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--nd-error);
  background: var(--nd-error-soft);
  border: 1px solid color-mix(in srgb, var(--nd-error) 35%, transparent);
}
.confirm-host__message {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.55;
  color: var(--nd-text);
}
.confirm-host__details {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  color: var(--nd-text);
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}
.confirm-host__actions {
  border-top: 1px solid var(--nd-hairline);
  padding: 12px 18px;
}
</style>
