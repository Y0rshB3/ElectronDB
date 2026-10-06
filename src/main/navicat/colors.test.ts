import { describe, expect, it } from 'vitest'
import { decodeMarkerColor, readMarkerColors } from './colors'
import { buildPrefPlist, encodeMarkerColor } from './testing'

describe('decodeMarkerColor', () => {
  it('decodes float32 components after the ffff marker', () => {
    expect(decodeMarkerColor(encodeMarkerColor(105 / 255, 240 / 255, 174 / 255))).toBe('#69f0ae')
    expect(decodeMarkerColor(encodeMarkerColor(1, 193 / 255, 7 / 255))).toBe('#ffc107')
  })

  it('decodes single-byte 0/1 components', () => {
    expect(decodeMarkerColor(encodeMarkerColor(1, 82 / 255, 82 / 255))).toBe('#ff5252')
    expect(decodeMarkerColor(encodeMarkerColor(0, 0, 1))).toBe('#0000ff')
  })

  it('accepts a plain Uint8Array', () => {
    const blob = encodeMarkerColor(1, 0, 0)
    expect(decodeMarkerColor(new Uint8Array(blob))).toBe('#ff0000')
  })

  it('clamps out-of-range components', () => {
    expect(decodeMarkerColor(encodeMarkerColor(1.5, -0.2, 0.5))).toBe('#ff0080')
  })

  it('returns null for missing, garbled or truncated blobs', () => {
    expect(decodeMarkerColor(undefined)).toBeNull()
    expect(decodeMarkerColor(null)).toBeNull()
    expect(decodeMarkerColor('ffff')).toBeNull()
    expect(decodeMarkerColor(Buffer.from('no marker here'))).toBeNull()
    expect(decodeMarkerColor(Buffer.from('ffff', 'latin1'))).toBeNull()
    expect(
      decodeMarkerColor(Buffer.concat([Buffer.from('ffff', 'latin1'), Buffer.from([0x83, 1, 2])]))
    ).toBeNull()
    expect(
      decodeMarkerColor(
        Buffer.concat([Buffer.from('ffff', 'latin1'), Buffer.from([0x99, 0x01, 0x01, 0x01])])
      )
    ).toBeNull()
    expect(decodeMarkerColor(Buffer.from([0, 1, 2, 3, 0xff, 0xfe]))).toBeNull()
  })
})

describe('readMarkerColors', () => {
  it('maps connection names to colours and skips connections without marker', async () => {
    const xml = buildPrefPlist({
      Dev: encodeMarkerColor(105 / 255, 240 / 255, 174 / 255),
      'Home Lab': null,
      Production: encodeMarkerColor(1, 82 / 255, 82 / 255)
    })
    const colors = await readMarkerColors(xml)
    expect([...colors.entries()]).toEqual([
      ['Dev', '#69f0ae'],
      ['Production', '#ff5252']
    ])
  })

  it('reads the Navicat CC layout with two empty-string levels before serverpref', async () => {
    const blob = encodeMarkerColor(1, 193 / 255, 7 / 255).toString('base64')
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>connpref</key><dict><key>0</key><dict><key>0</key><dict><key>MySQL</key><dict>
<key>Staging</key><dict><key></key><dict><key></key><dict><key>serverpref</key><dict><key>markercolor</key><data>${blob}</data></dict></dict></dict></dict>
<key>Home Lab</key><dict><key></key><dict><key></key><dict><key>serverpref</key><dict/></dict></dict></dict>
</dict></dict></dict></dict></dict></plist>`
    expect([...(await readMarkerColors(xml)).entries()]).toEqual([['Staging', '#ffc107']])
  })

  it('returns an empty map on invalid plist input', async () => {
    expect((await readMarkerColors('<not a plist')).size).toBe(0)
    expect((await readMarkerColors('<plist version="1.0"><array/></plist>')).size).toBe(0)
  })
})
