import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { QueryColumn } from '@shared/types'
import { createTestVuetify, installDomPolyfills } from '@renderer/__tests__/shellTestUtils'
import ResultGrid from './ResultGrid.vue'

function numericColumns(columns: QueryColumn[]): boolean[] {
  installDomPolyfills()
  const wrapper = mount(ResultGrid, {
    props: { columns, rows: [columns.map(() => '1')] },
    global: { plugins: [createTestVuetify()] }
  })
  const cells = wrapper.findAll('.result-grid__cell')
  const result = cells.map((c) => c.classes().includes('result-grid__cell--num'))
  wrapper.unmount()
  return result
}

describe('ResultGrid alignment', () => {
  it('right-aligns MySQL numeric type names when the driver sends no typeKind', () => {
    expect(
      numericColumns([
        { name: 'a', type: 'INT' },
        { name: 'b', type: 'DECIMAL' },
        { name: 'c', type: 'VARCHAR' },
        { name: 'd', type: 'YEAR' },
        // Not in the v0.1.0 list: stays left aligned.
        { name: 'e', type: 'BIT' }
      ])
    ).toEqual([true, true, false, true, false])
  })

  it('uses typeKind when present (PostgreSQL int4/numeric/float8, SQLite INTEGER/REAL)', () => {
    expect(
      numericColumns([
        { name: 'a', type: 'int4', typeKind: 'integer' },
        { name: 'b', type: 'numeric', typeKind: 'decimal' },
        { name: 'c', type: 'float8', typeKind: 'float' },
        { name: 'd', type: 'REAL', typeKind: 'float' },
        { name: 'e', type: 'INT', typeKind: 'text' },
        { name: 'f', type: 'uuid', typeKind: 'uuid' }
      ])
    ).toEqual([true, true, true, true, false, false])
  })
})
