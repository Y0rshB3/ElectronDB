import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError, invoke } from '@renderer/api'
import { useNotify } from '@renderer/composables/useNotify'
import { installBridge } from '@renderer/__tests__/shellTestUtils'
import { runSafely, wasNotified } from './errors'

describe('runSafely', () => {
  beforeEach(() => {
    const n = useNotify()
    for (const item of [...n.queue]) n.dismiss(item.id)
  })

  it('swallows API failures already shown by api.invoke without duplicating them', async () => {
    installBridge({
      'db:dropObject': () => {
        throw new Error('Tabla bloqueada')
      }
    })
    let caught: unknown
    await invoke('db:dropObject', 'c', 's', 'table', 't').catch((e) => (caught = e))
    expect(caught).toBeInstanceOf(ApiError)
    expect(wasNotified(caught)).toBe(true)
    expect(useNotify().queue).toHaveLength(1)

    await expect(
      runSafely(() => invoke('db:dropObject', 'c', 's', 'table', 't'))
    ).resolves.toBeUndefined()
    expect(useNotify().queue).toHaveLength(1)
  })

  it('reports unexpected errors once', async () => {
    await runSafely(() => {
      throw new Error('Algo raro')
    })
    expect(useNotify().queue.map((n) => n.message)).toContain('Algo raro')
  })

  it('accepts a missing action', async () => {
    await expect(runSafely(undefined)).resolves.toBeUndefined()
  })
})
