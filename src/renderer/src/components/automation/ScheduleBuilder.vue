<script setup lang="ts">
import { computed } from 'vue'
import { WEEKDAYS } from '@renderer/utils/cron'
import { formatDate } from '@renderer/utils/format'
import {
  SCHEDULE_MODES,
  cronFromForm,
  describeSchedule,
  isValidCron,
  nextRuns,
  type ScheduleForm,
  type ScheduleMode
} from './schedule'

const form = defineModel<ScheduleForm>({ required: true })
defineProps<{ disabled?: boolean }>()

const cron = computed(() => cronFromForm(form.value))
const valid = computed(() => isValidCron(cron.value))
const upcoming = computed(() => (valid.value ? nextRuns(cron.value, 5) : []))
/** Presentation of each mode card (the accessible name stays the mode title). */
const MODE_META: Record<ScheduleMode, { icon: string; label: string; caption: string }> = {
  daily: { icon: 'mdi-calendar-today-outline', label: 'Diaria', caption: 'cada día' },
  weekly: { icon: 'mdi-calendar-week-outline', label: 'Semanal', caption: 'días elegidos' },
  monthly: { icon: 'mdi-calendar-month-outline', label: 'Mensual', caption: 'un día al mes' },
  hourly: { icon: 'mdi-timer-sync-outline', label: 'Cada N horas', caption: 'intervalo' },
  custom: { icon: 'mdi-code-braces', label: 'Personalizada', caption: 'expresión cron' }
}
const days = Array.from({ length: 31 }, (_, i) => i + 1)

function patch(changes: Partial<ScheduleForm>): void {
  const next = { ...form.value, ...changes }
  // Keep the custom expression in sync so switching to "personalizada" starts from the current schedule.
  if (changes.mode === 'custom' && form.value.mode !== 'custom')
    next.expression = cronFromForm(form.value)
  form.value = next
}
</script>

<template>
  <div
    class="schedule-builder"
    :class="{ 'schedule-builder--disabled': disabled }"
    data-test="schedule-builder"
  >
    <div class="schedule-modes" role="radiogroup" aria-label="Frecuencia" data-test="schedule-mode">
      <button
        v-for="m in SCHEDULE_MODES"
        :key="m.value"
        type="button"
        role="radio"
        class="schedule-mode nd-transition"
        :class="{ 'schedule-mode--active': form.mode === m.value }"
        :aria-checked="form.mode === m.value"
        :aria-label="m.title"
        :disabled="disabled"
        @click="patch({ mode: m.value })"
      >
        <v-icon :icon="MODE_META[m.value].icon" size="18" aria-hidden="true" />
        <span class="schedule-mode__label">{{ MODE_META[m.value].label }}</span>
        <span class="schedule-mode__caption">{{ MODE_META[m.value].caption }}</span>
      </button>
    </div>

    <div class="schedule-fields">
      <v-text-field
        v-if="form.mode === 'daily' || form.mode === 'weekly' || form.mode === 'monthly'"
        :model-value="form.time"
        type="time"
        label="Hora"
        :disabled="disabled"
        class="schedule-fields__small nd-mono-input"
        data-test="schedule-time"
        @update:model-value="patch({ time: $event })"
      />
      <v-select
        v-if="form.mode === 'monthly'"
        :model-value="form.dayOfMonth"
        :items="days"
        label="Día del mes"
        :disabled="disabled"
        class="schedule-fields__small"
        @update:model-value="patch({ dayOfMonth: $event })"
      />
      <template v-if="form.mode === 'hourly'">
        <v-text-field
          :model-value="form.everyHours"
          type="number"
          min="1"
          max="23"
          label="Cada (horas)"
          :disabled="disabled"
          class="schedule-fields__small nd-mono-input"
          @update:model-value="patch({ everyHours: Number($event) })"
        />
        <v-text-field
          :model-value="form.minuteOfHour"
          type="number"
          min="0"
          max="59"
          label="En el minuto"
          :disabled="disabled"
          class="schedule-fields__small nd-mono-input"
          @update:model-value="patch({ minuteOfHour: Number($event) })"
        />
      </template>
      <v-text-field
        v-if="form.mode === 'custom'"
        :model-value="form.expression"
        label="Expresión cron (min hora día mes díaSemana)"
        placeholder="0 3 * * 1-5"
        :disabled="disabled"
        :error-messages="valid ? [] : ['Expresión cron inválida: se esperan 5 campos']"
        class="schedule-fields__wide nd-mono-input"
        data-test="schedule-expression"
        @update:model-value="patch({ expression: $event })"
      />
      <div v-if="form.mode === 'weekly'" class="schedule-days">
        <div class="nd-section-title mb-1">Días de la semana</div>
        <v-chip-group
          :model-value="form.days"
          multiple
          selected-class="schedule-day--on"
          aria-label="Días de la semana"
          @update:model-value="patch({ days: $event as number[] })"
        >
          <v-chip
            v-for="d in WEEKDAYS"
            :key="d.value"
            :value="d.value"
            :disabled="disabled"
            :title="d.label"
            variant="outlined"
            class="schedule-day"
            size="small"
            >{{ d.short }}</v-chip
          >
        </v-chip-group>
      </div>
    </div>

    <div class="schedule-preview" :class="{ 'schedule-preview--invalid': !valid }">
      <span class="nd-icon-badge schedule-preview__badge" aria-hidden="true">
        <v-icon icon="mdi-calendar-clock" size="16" />
      </span>
      <div class="schedule-preview__body">
        <div class="schedule-preview__title">
          <span>{{ describeSchedule(cron) }}</span>
          <code class="schedule-preview__cron" data-test="schedule-cron">{{ cron }}</code>
        </div>
        <div v-if="upcoming.length" class="schedule-preview__next">
          <span class="schedule-preview__next-label">Próximas ejecuciones:</span>
          <span
            v-for="date in upcoming"
            :key="date.getTime()"
            class="schedule-preview__date nd-mono"
            >{{ formatDate(date.getTime()) }}</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.schedule-modes {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}
.schedule-mode {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-height: 70px;
  min-width: 0;
  overflow: hidden;
  padding: 8px 6px;
  border-radius: var(--nd-radius-control);
  border: 1px solid var(--nd-border);
  background: var(--nd-bg-input);
  color: var(--nd-text-2);
  font: inherit;
  font-size: var(--nd-fs-dense);
  text-align: center;
  cursor: pointer;
}
.schedule-mode:hover:not(:disabled) {
  background: var(--nd-hover);
  color: var(--nd-text);
  transform: translateY(-1px);
}
.schedule-mode--active {
  color: var(--nd-text);
  background: var(--nd-accent-gradient-soft);
  border-color: rgba(var(--nd-accent-rgb), 0.5);
  box-shadow: var(--nd-glow);
}
.schedule-mode--active .v-icon {
  color: var(--nd-accent);
}
.schedule-mode:disabled {
  cursor: default;
  color: var(--nd-text-disabled);
}
.schedule-mode--active:disabled {
  box-shadow: none;
  border-color: var(--nd-border-strong);
}
.schedule-mode__label {
  line-height: 1.2;
  font-weight: 600;
  white-space: nowrap;
}
.schedule-mode__caption {
  font-size: 10.5px;
  line-height: 1.1;
  color: var(--nd-text-muted);
  white-space: nowrap;
}
.schedule-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
}
.schedule-fields:empty {
  display: none;
}
.schedule-fields__small {
  flex: 0 0 160px;
}
.schedule-fields__wide {
  flex: 1 1 320px;
}
.schedule-fields .nd-mono-input :deep(input) {
  font-family: var(--nd-font-mono);
}
.schedule-days {
  flex: 1 1 100%;
}
.schedule-day {
  font-weight: 600;
}
.schedule-day.schedule-day--on {
  color: var(--nd-text);
  background: var(--nd-accent-gradient-soft);
  border-color: rgba(var(--nd-accent-rgb), 0.55);
}
.schedule-preview {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--nd-radius-card);
  background: var(--nd-bg-sunken);
  border: 1px solid var(--nd-border);
}
.schedule-preview__badge {
  width: 30px;
  height: 30px;
}
.schedule-preview--invalid {
  border-color: color-mix(in srgb, var(--nd-error) 40%, transparent);
}
.schedule-builder--disabled .schedule-preview {
  opacity: 0.6;
}
.schedule-preview__body {
  flex: 1;
  min-width: 0;
}
.schedule-preview__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  min-height: 30px;
}
.schedule-preview__cron {
  padding: 1px 8px;
  border-radius: var(--nd-radius-pill);
  font-size: var(--nd-fs-xs);
  font-weight: 500;
  color: var(--nd-accent);
  background: rgba(var(--nd-accent-rgb), 0.1);
  border: 1px solid rgba(var(--nd-accent-rgb), 0.25);
}
.schedule-preview__next {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.schedule-preview__date {
  padding: 1px 7px;
  border-radius: var(--nd-radius-sm);
  background: var(--nd-hover);
  border: 1px solid var(--nd-hairline);
  color: var(--nd-text);
}
</style>
