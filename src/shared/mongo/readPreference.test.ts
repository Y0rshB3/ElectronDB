import { describe, expect, it } from 'vitest'
import { MONGO_READ_PREFERENCE_LABELS, readPreferenceLabel } from './readPreference'

describe('readPreferenceLabel', () => {
  it('names every read preference in Spanish', () => {
    expect(readPreferenceLabel('primary')).toBe('Primario')
    expect(readPreferenceLabel('primaryPreferred')).toBe('Primario preferido')
    expect(readPreferenceLabel('secondary')).toBe('Secundario')
    expect(readPreferenceLabel('secondaryPreferred')).toBe('Secundario preferido')
    expect(readPreferenceLabel('nearest')).toBe('Más cercano')
    expect(Object.keys(MONGO_READ_PREFERENCE_LABELS)).toHaveLength(5)
  })

  it('shows an unknown value as is', () => {
    expect(readPreferenceLabel('other')).toBe('other')
  })
})
