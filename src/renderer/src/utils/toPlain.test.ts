import { describe, expect, it } from 'vitest'
import { reactive, ref } from 'vue'
import { toPlain } from './toPlain'

describe('toPlain', () => {
  it('makes reactive form state structured-cloneable', () => {
    const form = reactive({
      name: 'Local',
      port: 13306,
      ssh: { enabled: false, host: '' },
      customDatabases: ['a', 'b'],
      extra: ref({ x: 1 })
    })
    expect(() => structuredClone(form)).toThrow()
    const plain = toPlain(form)
    expect(() => structuredClone(plain)).not.toThrow()
    expect(plain).toEqual({
      name: 'Local',
      port: 13306,
      ssh: { enabled: false, host: '' },
      customDatabases: ['a', 'b'],
      extra: { x: 1 }
    })
  })

  it('keeps primitives, null, dates and drops functions', () => {
    const d = new Date(0)
    expect(toPlain(null)).toBeNull()
    expect(toPlain('x')).toBe('x')
    expect(toPlain({ d, f: () => 1 })).toEqual({ d })
  })
})
