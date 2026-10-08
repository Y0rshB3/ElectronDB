<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { environmentLabel, environmentPillClass } from '@renderer/components/backups/backupHelpers'
import { useUiStore } from '@renderer/stores/ui'

/** Renders the single global confirmation requested through ui.ask(). */
const ui = useUiStore()
const typed = ref('')
const cancelButton = ref<{ $el: HTMLElement } | null>(null)

const request = computed(() => ui.confirm)
const bannerText = computed(() => {
  const env = request.value.typedEnvironment ?? 'production'
  return env === 'production'
    ? 'Conexión de PRODUCCIÓN'
    : `Entorno ${environmentLabel(env).toUpperCase()} · requiere escribir el nombre`
})
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

/**
 * Destructive confirmations focus "Cancelar" so Enter never deletes by accident.
 * The autofocus attribute alone is unreliable for content inserted after load.
 */
function onAfterEnter(): void {
  if (request.value.danger && !needsTyping.value) cancelButton.value?.$el.focus()
}

function confirm(): void {
  if (canConfirm.value) ui.answer(true)
}
</script>

<template>
  <v-dialog
    v-model="open"
    :max-width="request.items?.length ? 560 : 500"
    :persistent="request.production"
    data-test="confirm-dialog"
    @after-enter="onAfterEnter"
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
                : request.danger
                  ? 'mdi-delete-alert-outline'
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
          <v-icon
            :icon="
              (request.typedEnvironment ?? 'production') === 'production'
                ? 'mdi-shield-alert-outline'
                : 'mdi-lock-outline'
            "
            size="16"
          />
          <span>{{ bannerText }}</span>
        </div>
        <div
          v-if="request.connection"
          class="confirm-host__connection"
          data-test="confirm-connection"
        >
          <v-icon icon="mdi-database-outline" size="15" aria-hidden="true" />
          <span class="nd-ellipsis">{{ request.connection.name }}</span>
          <span class="nd-pill" :class="environmentPillClass(request.connection.environment)">{{
            environmentLabel(request.connection.environment)
          }}</span>
        </div>
        <p class="confirm-host__message" data-test="confirm-message">{{ request.message }}</p>
        <ul
          v-if="request.items?.length"
          class="confirm-host__items"
          aria-label="Elementos afectados"
          data-test="confirm-items"
        >
          <li v-for="(item, index) in request.items" :key="index" class="confirm-host__item">
            <span v-if="item.tag" class="confirm-host__tag">{{ item.tag }}</span>
            <code class="confirm-host__text">{{ item.text }}</code>
            <span
              v-if="item.warning"
              class="confirm-host__warning"
              data-test="confirm-item-warning"
            >
              <v-icon icon="mdi-alert-outline" size="13" aria-hidden="true" />{{ item.warning }}
            </span>
          </li>
        </ul>
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
          ref="cancelButton"
          variant="text"
          :autofocus="!!request.danger && !needsTyping"
          data-test="confirm-cancel"
          @click="ui.answer(false)"
          >{{ request.cancelText ?? 'Cancelar' }}</v-btn
        >
        <v-btn
          :color="request.color ?? 'primary'"
          variant="flat"
          :disabled="!canConfirm"
          :autofocus="!needsTyping && !request.danger"
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
.confirm-host__connection {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  min-width: 0;
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  color: var(--nd-text);
}
.confirm-host__connection .v-icon {
  color: var(--nd-text-muted);
  flex: none;
}
.confirm-host__connection .nd-pill {
  flex: none;
}
.confirm-host__items {
  list-style: none;
  margin: 12px 0 0;
  padding: 4px 0;
  border-radius: var(--nd-radius-control);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
  max-height: 220px;
  overflow: auto;
}
.confirm-host__item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: 6px 12px;
}
.confirm-host__item + .confirm-host__item {
  border-top: 1px solid var(--nd-hairline);
}
.confirm-host__tag {
  flex: none;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  line-height: 18px;
  color: var(--nd-error);
  background: var(--nd-error-soft);
}
.confirm-host__text {
  flex: 1 1 200px;
  min-width: 0;
  font-family: var(--nd-font-mono);
  font-size: var(--nd-fs-dense);
  line-height: 1.5;
  color: var(--nd-text);
  white-space: pre-wrap;
  word-break: break-word;
  background: none;
  padding: 0;
}
.confirm-host__warning {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-basis: 100%;
  font-size: var(--nd-fs-dense);
  font-weight: 600;
  color: var(--nd-error);
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
