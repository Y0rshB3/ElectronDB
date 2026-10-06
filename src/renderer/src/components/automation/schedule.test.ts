import { describe, expect, it } from 'vitest'
import { scheduleParts } from './schedule'

describe('scheduleParts', () => {
  it('splits custom expressions so the cron can be rendered in mono', () => {
    expect(scheduleParts('30 2 * * 1-5')).toEqual({
      label: 'Personalizada: ',
      cron: '30 2 * * 1-5'
    })
  })

  it('keeps human descriptions as a single label', () => {
    const parts = scheduleParts('0 3 * * *')
    expect(parts.cron).toBeNull()
    expect(parts.label).not.toContain('Personalizada')
  })
})
