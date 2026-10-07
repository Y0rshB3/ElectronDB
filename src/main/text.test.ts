import { describe, expect, it } from 'vitest'
import { isPrintable } from './text'

describe('isPrintable', () => {
  it('accepts text with tabs, newlines and non-ASCII letters', () => {
    expect(isPrintable('contraseña\tcon\nlíneas')).toBe(true)
  })
  it('rejects empty text, control characters and replacement characters', () => {
    expect(isPrintable('')).toBe(false)
    expect(isPrintable('a\u0000b')).toBe(false)
    expect(isPrintable('a\u007fb')).toBe(false)
    expect(isPrintable('a�b')).toBe(false)
  })
})
