import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nodeIds, useTreeStore } from './tree'
import { useConnectionsStore } from './connections'
import {
  installBridge,
  makeConnection,
  makeServerInfo,
  makeTable,
  type MockBridge
} from '@renderer/__tests__/shellTestUtils'

const calls = (bridge: MockBridge, channel: string) =>
  bridge.invoke.mock.calls.filter(([ch]) => ch === channel)

describe('tree store lazy loading', () => {
  let bridge: MockBridge

  beforeEach(async () => {
    setActivePinia(createPinia())
    bridge = installBridge({
      'connections:list': [
        makeConnection({ id: 'c1' }),
        makeConnection({ id: 'c2', name: 'Filtered', customDatabases: ['app'] })
      ],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [
        { name: 'app', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
        { name: 'other', characterSet: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }
      ],
      'db:tables': () => [makeTable('users'), makeTable('orders')]
    })
    await useConnectionsStore().load()
  })

  it('has no children for a closed connection and does not hit the server', () => {
    const tree = useTreeStore()
    const node = tree.parse(nodeIds.connection('c1'))!
    expect(tree.childrenOf(node)).toEqual([])
    expect(calls(bridge, 'db:databases')).toHaveLength(0)
  })

  it('expanding a connection opens it and loads its databases', async () => {
    const tree = useTreeStore()
    const node = tree.parse(nodeIds.connection('c1'))!
    await tree.expand(node)
    expect(calls(bridge, 'connections:open')).toHaveLength(1)
    expect(tree.isExpanded(node.id)).toBe(true)
    expect(tree.childrenOf(node).map((n) => n.label)).toEqual(['app', 'other'])
  })

  it('applies customDatabases filtering', async () => {
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('c2'))!)
    expect(tree.databases.c2.map((d) => d.name)).toEqual(['app'])
  })

  it('schemas expose the six Navicat groups without loading anything', async () => {
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('c1'))!)
    const schema = tree.parse(nodeIds.schema('c1', 'app'))!
    const groups = tree.childrenOf(schema).map((n) => n.group)
    expect(groups).toEqual(['tables', 'views', 'functions', 'events', 'queries', 'backups'])
    expect(calls(bridge, 'db:tables')).toHaveLength(0)
  })

  it('loads a group once, caches it and reloads on refresh', async () => {
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('c1'))!)
    const group = tree.parse(nodeIds.group('c1', 'app', 'tables'))!
    await tree.expand(group)
    await tree.expand(group)
    expect(calls(bridge, 'db:tables')).toHaveLength(1)
    expect(tree.childrenOf(group).map((n) => n.label)).toEqual(['users', 'orders'])
    await tree.refresh(group)
    expect(calls(bridge, 'db:tables')).toHaveLength(2)
  })

  it('stores load errors on the node instead of throwing', async () => {
    installBridge({
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [{ name: 'app', characterSet: 'utf8mb4', collation: 'x' }],
      'db:tables': () => {
        throw new Error('SELECT command denied')
      }
    })
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('c1'))!)
    const group = tree.parse(nodeIds.group('c1', 'app', 'tables'))!
    await tree.expand(group)
    expect(tree.errors[group.id]).toContain('SELECT command denied')
    expect(tree.loading[group.id]).toBeUndefined()
  })

  it('forget() drops cached data and moves the selection to the connection', async () => {
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('c1'))!)
    await tree.loadGroup('c1', 'app', 'tables')
    tree.select(nodeIds.object('c1', 'app', 'tables', 'users'))
    tree.forget('c1')
    expect(tree.databases.c1).toBeUndefined()
    expect(tree.hasItems('c1', 'app', 'tables')).toBe(false)
    expect(tree.selectedId).toBe(nodeIds.connection('c1'))
  })
})
