import type { MongoReadPreference } from '../types'

/** Spanish names of the read preferences (connection dialog and info panel). */
export const MONGO_READ_PREFERENCE_LABELS: Record<MongoReadPreference, string> = {
  primary: 'Primario',
  primaryPreferred: 'Primario preferido',
  secondary: 'Secundario',
  secondaryPreferred: 'Secundario preferido',
  nearest: 'Más cercano'
}

/** Label of `value`; an unknown value is shown as is. */
export function readPreferenceLabel(value: string): string {
  return MONGO_READ_PREFERENCE_LABELS[value as MongoReadPreference] ?? value
}
