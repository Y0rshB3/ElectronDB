import type { ConnectionConfig, ConnectionInput } from '@shared/types'
import type { AppContext } from '../context'
import { getConnectionManager } from '../mysql/manager'
import { getAiService } from '../ai'
import { handle } from './typed'

/** Fields whose change invalidates an open pool. */
function endpointSignature(c: ConnectionInput | ConnectionConfig): string {
  return JSON.stringify([
    c.host,
    c.port,
    c.username,
    c.authMode ?? 'password',
    c.ssh,
    c.ssl,
    c.initialQueries
  ])
}

function validateInput(input: ConnectionInput): void {
  if (!input.name?.trim()) throw new Error('El nombre de la conexión es obligatorio')
  if (!input.host?.trim()) throw new Error('El host de la conexión es obligatorio')
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error('El puerto debe ser un número entre 1 y 65535')
  }
  if (!input.username?.trim()) throw new Error('El usuario de la conexión es obligatorio')
}

export function registerConnectionsHandlers(ctx: AppContext): void {
  const manager = getConnectionManager(ctx)

  handle('connections:list', () => ctx.connections.list())
  handle('connections:get', (id) => ctx.connections.get(id))

  handle('connections:save', async (input) => {
    validateInput(input)
    const previous = input.id ? ctx.connections.get(input.id) : null
    const saved = ctx.connections.save(input)
    // A live pool built with the old endpoint would silently keep using it.
    if (
      previous &&
      manager.isOpen(saved.id) &&
      endpointSignature(previous) !== endpointSignature(saved)
    ) {
      await manager.close(saved.id)
    }
    return saved
  })

  handle('connections:delete', async (id) => {
    await manager.close(id)
    ctx.credentials.deleteAll(id)
    ctx.connections.delete(id)
    // The assistant's notes and conversations of that connection go with it.
    const ai = getAiService(ctx)
    ai.conversations.deleteConnection(id)
    ai.memory.deleteConnection(id)
  })

  handle('connections:test', (input, password, sshPassword) =>
    manager.test(input, password, sshPassword)
  )

  handle('connections:setPassword', (id, password) => ctx.credentials.set('mysql', id, password))
  handle('connections:hasPassword', (id) => ctx.credentials.has('mysql', id))
  handle('connections:setSshPassword', (id, password) => ctx.credentials.set('ssh', id, password))
  handle('connections:hasSshPassword', (id) => ctx.credentials.has('ssh', id))

  handle('connections:open', (id) => manager.open(id))
  handle('connections:close', (id) => manager.close(id))
  handle('connections:isOpen', (id) => manager.isOpen(id))
}
