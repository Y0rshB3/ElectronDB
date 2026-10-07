import { describe, expect, it } from 'vitest'
import { ENGINES } from '@shared/engines'
import { emptyConnectionInput } from '@renderer/components/dialogs/connectionForm'
import { GROUPS } from './objectTypes'

// The MySQL descriptor must describe what the UI does today (no behaviour change).
describe('MySQL engine descriptor parity with the renderer', () => {
  it('lists the tree groups in the same order', () => {
    expect(ENGINES.mysql.groups).toEqual(GROUPS)
  })

  it('uses the connection form defaults', () => {
    const empty = emptyConnectionInput()
    expect(empty.engine).toBe('mysql')
    expect(ENGINES.mysql.defaultPort).toBe(empty.port)
    expect(ENGINES.mysql.defaultUser).toBe(empty.username)
  })
})
