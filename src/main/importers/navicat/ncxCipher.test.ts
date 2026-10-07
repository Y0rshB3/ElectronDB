import { describe, expect, it } from 'vitest'
import { Blowfish, piFractionHex } from './blowfish'
import {
  decodeNcxPassword,
  decryptNcxAes,
  decryptNcxBlowfish,
  encryptNcxAes,
  encryptNcxBlowfish
} from './ncxCipher'

describe('Blowfish', () => {
  it('derives the standard P-array from pi', () => {
    expect(piFractionHex(16)).toBe('243f6a8885a308d3')
  })

  it('matches the published test vectors', () => {
    const zero = new Blowfish(Buffer.alloc(8))
    expect(zero.encryptBlock(Buffer.alloc(8)).toString('hex')).toBe('4ef997456198dd78')
    expect(zero.decryptBlock(Buffer.from('4ef997456198dd78', 'hex')).toString('hex')).toBe(
      '0000000000000000'
    )
    const ones = new Blowfish(Buffer.alloc(8, 0xff))
    expect(ones.encryptBlock(Buffer.alloc(8, 0xff)).toString('hex')).toBe('51866fd5b85ecb8a')
    const words = new Blowfish(Buffer.from('0123456789ABCDEF', 'hex'))
    expect(words.encryptBlock(Buffer.from('1111111111111111', 'hex')).toString('hex')).toBe(
      '61f9c3802281b096'
    )
  })
})

describe('.ncx password schemes', () => {
  it('round-trips the AES scheme', () => {
    const hex = encryptNcxAes('p4ss-wörd!')
    expect(hex).toMatch(/^[0-9A-F]+$/)
    expect(decryptNcxAes(hex)).toBe('p4ss-wörd!')
    expect(decryptNcxAes(hex.toLowerCase())).toBe('p4ss-wörd!')
    expect(decryptNcxAes('zz')).toBeNull()
    expect(decryptNcxAes('00112233445566778899aabbccddeeff')).toBeNull()
  })

  it('round-trips the Blowfish scheme for whole and partial blocks', () => {
    for (const plain of [
      'a',
      '12345678',
      'secret-password-1',
      'exactly16chars!!',
      'ünïcödé pass'
    ]) {
      const hex = encryptNcxBlowfish(plain)
      expect(hex).toMatch(/^[0-9A-F]+$/)
      expect(decryptNcxBlowfish(hex)).toBe(plain)
    }
    expect(decryptNcxBlowfish('not hex')).toBeNull()
    expect(decryptNcxBlowfish('')).toBeNull()
  })

  it('decodes either scheme and rejects empty or undecodable values', () => {
    expect(decodeNcxPassword(encryptNcxAes('one'))).toBe('one')
    expect(decodeNcxPassword(` ${encryptNcxBlowfish('two')}\n`)).toBe('two')
    expect(decodeNcxPassword('')).toBeNull()
    expect(decodeNcxPassword(' ')).toBeNull()
    expect(decodeNcxPassword('plain text')).toBeNull()
  })
})
