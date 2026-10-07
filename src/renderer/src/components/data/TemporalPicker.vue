<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  formatTemporal,
  monthGrid,
  nowParts,
  parseTemporal,
  type DateParts,
  type ParsedTemporal,
  type TemporalSpec,
  type TimeParts
} from './temporal'

/**
 * Compact calendar / time popover content. Works on the MySQL
 * literal text only: picking a day or a time rewrites the text, never through
 * a JS Date, so there is no timezone shift.
 */
const props = defineProps<{
  modelValue: string
  spec: TemporalSpec
  nullable: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [text: string]
  accept: []
  null: []
}>()

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre'
]
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']

const ZERO_TIME: TimeParts = { negative: false, hours: 0, minutes: 0, seconds: 0, fraction: '' }

const parsed = computed<ParsedTemporal | null>(() => {
  const r = parseTemporal(props.modelValue, props.spec.kind)
  return r.ok ? r.value : null
})
const hasDate = computed(() => props.spec.kind === 'date' || props.spec.kind === 'datetime')
const hasTime = computed(() => props.spec.kind === 'time' || props.spec.kind === 'datetime')

const today = nowParts().date
const view = ref({ year: today.year, month: today.month })
watch(
  parsed,
  (p) => {
    if (p?.date) view.value = { year: p.date.year, month: p.date.month }
    else if (p?.year) view.value = { ...view.value, year: p.year }
  },
  { immediate: true }
)

const weeks = computed(() => monthGrid(view.value.year, view.value.month))
const time = computed<TimeParts>(() => parsed.value?.time ?? ZERO_TIME)

function write(next: Partial<ParsedTemporal>): void {
  const base: ParsedTemporal = parsed.value ?? { date: null, time: null, year: null, zero: false }
  const value: ParsedTemporal = { ...base, ...next }
  if (next.date) value.zero = false
  emit('update:modelValue', formatTemporal(value, props.spec))
}

function shiftMonth(delta: number): void {
  let { year, month } = view.value
  month += delta
  if (month < 1) {
    month = 12
    year--
  } else if (month > 12) {
    month = 1
    year++
  }
  view.value = { year, month }
}

function pickDay(day: number): void {
  const date: DateParts = { year: view.value.year, month: view.value.month, day }
  write({ date, time: hasTime.value ? time.value : null })
  if (props.spec.kind === 'date') emit('accept')
}

function isSelected(day: number | null): boolean {
  const d = parsed.value?.date
  return !!day && !!d && d.year === view.value.year && d.month === view.value.month && d.day === day
}

function isToday(day: number | null): boolean {
  return (
    !!day && today.year === view.value.year && today.month === view.value.month && today.day === day
  )
}

const LIMITS = { hours: 23, minutes: 59, seconds: 59 } as const
function setTime(field: 'hours' | 'minutes' | 'seconds', raw: string): void {
  const max = props.spec.kind === 'time' && field === 'hours' ? 838 : LIMITS[field]
  const n = Math.min(max, Math.max(0, Math.trunc(Number(raw) || 0)))
  write({
    time: { ...time.value, [field]: n },
    date: parsed.value?.date ?? (hasDate.value ? today : null)
  })
}
function setFraction(raw: string): void {
  const digits = raw.replace(/\D/g, '').slice(0, props.spec.fsp)
  write({
    time: { ...time.value, fraction: digits },
    date: parsed.value?.date ?? (hasDate.value ? today : null)
  })
}

function now(): void {
  const n = nowParts()
  if (props.spec.kind === 'year') write({ year: n.date.year })
  else if (props.spec.kind === 'date') write({ date: n.date })
  else if (props.spec.kind === 'time') write({ time: n.time })
  else write({ date: n.date, time: n.time })
  view.value = { year: n.date.year, month: n.date.month }
}

const years = computed(() => {
  const start = view.value.year - (view.value.year % 12)
  return Array.from({ length: 12 }, (_, i) => start + i)
})
function pickYear(year: number): void {
  write({ year, zero: false })
  emit('accept')
}
const pad2 = (n: number): string => String(n).padStart(2, '0')
</script>

<template>
  <div
    class="tpick"
    role="dialog"
    aria-label="Selector de fecha y hora"
    data-test="temporal-picker"
  >
    <template v-if="spec.kind === 'year'">
      <div class="tpick__head">
        <button
          type="button"
          class="tpick__nav"
          aria-label="Años anteriores"
          @click="view.year -= 12"
        >
          ‹
        </button>
        <span class="tpick__title">{{ years[0] }} – {{ years[11] }}</span>
        <button
          type="button"
          class="tpick__nav"
          aria-label="Años siguientes"
          @click="view.year += 12"
        >
          ›
        </button>
      </div>
      <div class="tpick__years">
        <button
          v-for="y in years"
          :key="y"
          type="button"
          class="tpick__cell"
          :class="{ 'is-selected': parsed?.year === y }"
          :data-test="`temporal-year-${y}`"
          @click="pickYear(y)"
        >
          {{ y }}
        </button>
      </div>
    </template>

    <template v-if="hasDate">
      <div class="tpick__head">
        <button type="button" class="tpick__nav" aria-label="Mes anterior" @click="shiftMonth(-1)">
          ‹
        </button>
        <span class="tpick__title">{{ MONTHS[view.month - 1] }} {{ view.year }}</span>
        <button type="button" class="tpick__nav" aria-label="Mes siguiente" @click="shiftMonth(1)">
          ›
        </button>
      </div>
      <p v-if="parsed?.zero" class="tpick__zero">
        Fecha cero (0000-00-00): elige un día para cambiarla.
      </p>
      <table class="tpick__grid" role="grid">
        <thead>
          <tr>
            <th v-for="d in WEEKDAYS" :key="d" scope="col">{{ d }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(week, w) in weeks" :key="w">
            <td v-for="(day, i) in week" :key="i">
              <button
                v-if="day"
                type="button"
                class="tpick__cell"
                :class="{ 'is-selected': isSelected(day), 'is-today': isToday(day) }"
                :aria-label="`${day} de ${MONTHS[view.month - 1]} de ${view.year}`"
                :data-test="`temporal-day-${day}`"
                @click="pickDay(day)"
              >
                {{ day }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <div v-if="hasTime" class="tpick__time" data-test="temporal-time">
      <span class="tpick__label">Hora</span>
      <input
        class="tpick__num"
        :class="{ 'is-wide': spec.kind === 'time' }"
        inputmode="numeric"
        :value="pad2(time.hours)"
        aria-label="Horas"
        data-test="temporal-hours"
        @change="setTime('hours', ($event.target as HTMLInputElement).value)"
      />
      <span>:</span>
      <input
        class="tpick__num"
        inputmode="numeric"
        :value="pad2(time.minutes)"
        aria-label="Minutos"
        data-test="temporal-minutes"
        @change="setTime('minutes', ($event.target as HTMLInputElement).value)"
      />
      <span>:</span>
      <input
        class="tpick__num"
        inputmode="numeric"
        :value="pad2(time.seconds)"
        aria-label="Segundos"
        data-test="temporal-seconds"
        @change="setTime('seconds', ($event.target as HTMLInputElement).value)"
      />
      <template v-if="spec.fsp > 0">
        <span>.</span>
        <input
          class="tpick__num is-frac"
          inputmode="numeric"
          :value="time.fraction.padEnd(spec.fsp, '0').slice(0, spec.fsp)"
          :aria-label="`Fracción de segundo (${spec.fsp} dígitos)`"
          data-test="temporal-fraction"
          @change="setFraction(($event.target as HTMLInputElement).value)"
        />
      </template>
    </div>

    <div class="tpick__actions">
      <button type="button" class="tpick__link" data-test="temporal-now" @click="now">
        {{ spec.kind === 'date' ? 'Hoy' : spec.kind === 'year' ? 'Este año' : 'Ahora' }}
      </button>
      <button
        v-if="nullable"
        type="button"
        class="tpick__link"
        data-test="temporal-null"
        @click="emit('null')"
      >
        NULL
      </button>
      <span class="tpick__spacer" />
      <button
        type="button"
        class="tpick__accept"
        data-test="temporal-accept"
        @click="emit('accept')"
      >
        Aceptar
      </button>
    </div>
  </div>
</template>

<style scoped>
.tpick {
  width: 236px;
  padding: 8px;
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-dense);
  color: var(--nd-text);
  background: var(--nd-bg-raised);
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-control);
  box-shadow: var(--nd-shadow-2, 0 8px 24px rgba(0, 0, 0, 0.45));
}
.tpick__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.tpick__title {
  font-weight: 600;
  text-transform: capitalize;
}
.tpick__nav {
  width: 24px;
  height: 22px;
  border: 0;
  border-radius: var(--nd-radius-sm);
  background: transparent;
  color: var(--nd-text-2);
  font-size: 16px;
  cursor: pointer;
}
.tpick__nav:hover {
  background: var(--nd-hover);
  color: var(--nd-text);
}
.tpick__zero {
  margin: 0 0 4px;
  font-size: var(--nd-fs-xs);
  color: var(--nd-warning);
}
.tpick__grid {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.tpick__grid th {
  height: 20px;
  font-size: var(--nd-fs-xs);
  font-weight: 500;
  color: var(--nd-text-muted);
}
.tpick__grid td {
  padding: 1px;
  text-align: center;
}
.tpick__cell {
  width: 100%;
  height: 24px;
  border: 0;
  border-radius: var(--nd-radius-sm);
  background: transparent;
  color: var(--nd-text);
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.tpick__cell:hover {
  background: var(--nd-hover);
}
.tpick__cell.is-today {
  box-shadow: inset 0 0 0 1px rgba(var(--nd-accent-rgb), 0.5);
}
.tpick__cell.is-selected {
  background: rgb(var(--nd-accent-rgb));
  color: var(--nd-bg-app);
  font-weight: 600;
}
.tpick__years {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
}
.tpick__time {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--nd-hairline);
  font-family: var(--nd-font-mono);
}
.tpick__label {
  margin-right: auto;
  font-family: var(--nd-font-ui);
  font-size: var(--nd-fs-xs);
  color: var(--nd-text-2);
}
.tpick__num {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--nd-border);
  border-radius: var(--nd-radius-sm);
  background: var(--nd-bg-sunken);
  color: var(--nd-text);
  font: inherit;
  text-align: center;
  outline: none;
}
.tpick__num.is-wide {
  width: 38px;
}
.tpick__num.is-frac {
  width: 52px;
}
.tpick__num:focus {
  border-color: rgba(var(--nd-accent-rgb), 0.7);
}
.tpick__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.tpick__spacer {
  flex: 1 1 auto;
}
.tpick__link {
  height: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--nd-radius-sm);
  background: transparent;
  color: var(--nd-accent);
  font: inherit;
  cursor: pointer;
}
.tpick__link:hover {
  background: var(--nd-hover);
}
.tpick__accept {
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--nd-radius-sm);
  background: rgba(var(--nd-accent-rgb), 0.18);
  color: var(--nd-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.tpick__accept:hover {
  background: rgba(var(--nd-accent-rgb), 0.28);
}
</style>
