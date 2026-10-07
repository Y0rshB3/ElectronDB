import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = (f: string): string => readFileSync(resolve(__dirname, f), 'utf8')

describe('field focus glow', () => {
  it('draws the glow on the outline, not as a box-shadow on the field box', () => {
    const v = css('vuetify-overrides.css')
    expect(v).toMatch(/\.v-field--focused \.v-field__outline \{\s*filter: var\(--nd-glow-filter\)/)
    expect(v).not.toMatch(
      /\.v-field--variant-outlined\.v-field--focused \{\s*box-shadow: var\(--nd-glow\)/
    )
  })

  it('removes the global focus-visible glow from inputs inside fields', () => {
    expect(css('global.css')).toMatch(/\.v-field input:focus-visible,[\s\S]*?box-shadow: none;/)
  })
})
