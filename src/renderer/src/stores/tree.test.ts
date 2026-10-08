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

describe('tree node ids (escaped segments)', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    installBridge({
      'connections:list': [makeConnection({ id: 'c1' })],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [
        { name: 'a', characterSet: 'utf8mb4', collation: 'x' },
        { name: 'a:b', characterSet: 'utf8mb4', collation: 'x' }
      ],
      'db:tables': (_c: unknown, schema: unknown) =>
        schema === 'a:b' ? [makeTable('t:1'), makeTable('100%')] : [makeTable('plain')]
    })
    await useConnectionsStore().load()
  })

  it('keeps the v0.1.0 id for names without reserved characters', () => {
    expect(nodeIds.connection('c1')).toBe('c:c1')
    expect(nodeIds.schema('c1', 'shop')).toBe('s:c1:shop')
    expect(nodeIds.group('c1', 'shop', 'tables')).toBe('g:c1:shop:tables')
    expect(nodeIds.object('c1', 'shop', 'tables', 'users')).toBe('o:c1:shop:tables:users')
  })

  it('round-trips database and object names that contain ":" or "%"', () => {
    const tree = useTreeStore()
    const object = tree.parse(nodeIds.object('c1', 'a:b', 'tables', 't:1'))!
    expect(object).toMatchObject({
      kind: 'object',
      connectionId: 'c1',
      schema: 'a:b',
      group: 'tables',
      name: 't:1',
      label: 't:1',
      parentId: nodeIds.group('c1', 'a:b', 'tables')
    })
    const group = tree.parse(object.parentId!)!
    expect(group).toMatchObject({ kind: 'group', schema: 'a:b', group: 'tables' })
    expect(tree.parse(group.parentId!)).toMatchObject({ kind: 'schema', label: 'a:b' })
    expect(tree.parse(nodeIds.object('c1', 'x', 'tables', '100%'))?.name).toBe('100%')
  })

  it('rejects malformed ids instead of mis-parsing them', () => {
    const tree = useTreeStore()
    expect(tree.parse('o:c1:a:b:tables:t')).toBeNull()
    expect(tree.parse('s:c1:%E0%A4%A')).toBeNull()
    expect(tree.parse('x:c1')).toBeNull()
  })

  it('lists, refreshes and forgets a database whose name contains ":"', async () => {
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('c1'))!)
    const schemas = tree.childrenOf(tree.parse(nodeIds.connection('c1'))!)
    expect(schemas.map((n) => n.label)).toEqual(['a', 'a:b'])

    await tree.loadGroup('c1', 'a', 'tables')
    const group = tree.parse(nodeIds.group('c1', 'a:b', 'tables'))!
    await tree.expand(group)
    expect(tree.childrenOf(group).map((n) => [n.name, n.label])).toEqual([
      ['t:1', 't:1'],
      ['100%', '100%']
    ])

    // Refreshing database "a" must not drop the cache of database "a:b".
    await tree.refresh(tree.parse(nodeIds.schema('c1', 'a'))!)
    expect(tree.hasItems('c1', 'a:b', 'tables')).toBe(true)

    tree.select(nodeIds.object('c1', 'a:b', 'tables', 't:1'))
    tree.forget('c1')
    expect(tree.hasItems('c1', 'a:b', 'tables')).toBe(false)
    expect(tree.isExpanded(group.id)).toBe(false)
    expect(tree.selectedId).toBe(nodeIds.connection('c1'))
  })
})

describe('tree groups follow the engine', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    installBridge({
      'connections:list': [
        makeConnection({ id: 'my' }),
        makeConnection({ id: 'pg', engine: 'postgresql' }),
        makeConnection({ id: 'lite', engine: 'sqlite' }),
        makeConnection({ id: 'odd', engine: 'oracle' as never })
      ]
    })
    await useConnectionsStore().load()
  })

  it('MySQL keeps the six Navicat groups; other engines only get the groups they support', () => {
    const tree = useTreeStore()
    expect(tree.groupsOf('my')).toEqual([
      'tables',
      'views',
      'functions',
      'events',
      'queries',
      'backups'
    ])
    expect(tree.groupsOf('pg')).toEqual([
      'tables',
      'views',
      'materializedViews',
      'functions',
      'sequences',
      'types',
      'queries'
    ])
    expect(tree.groupsOf('lite')).toEqual(['tables', 'views', 'indexes', 'triggers', 'queries'])
    expect(tree.groupsOf('odd')).toEqual([])
    const schema = tree.parse(nodeIds.schema('pg', 'app'))!
    expect(tree.childrenOf(schema).map((n) => n.group)).toEqual(tree.groupsOf('pg'))
  })
})

describe('PostgreSQL database level', () => {
  const calls: unknown[][] = []
  beforeEach(async () => {
    setActivePinia(createPinia())
    calls.length = 0
    installBridge({
      'connections:list': [
        makeConnection({
          id: 'pg',
          engine: 'postgresql',
          postgres: {
            initialDatabase: 'app',
            showSystemSchemas: false,
            timeZone: '',
            searchPath: ''
          }
        })
      ],
      'connections:open': () => makeServerInfo(),
      'db:databases': () => [
        { name: 'app', characterSet: 'UTF8', collation: 'C' },
        { name: 'shop:eu', characterSet: 'UTF8', collation: 'C' }
      ],
      'db:schemas': (...args: unknown[]) => {
        calls.push(['db:schemas', ...args])
        return [{ name: 'public', owner: 'postgres', comment: '', system: false }]
      },
      'db:tables': (...args: unknown[]) => {
        calls.push(['db:tables', ...args])
        return [
          {
            name: 'users',
            engine: null,
            rows: null,
            dataLength: null,
            indexLength: null,
            autoIncrement: null,
            createTime: null,
            updateTime: null,
            collation: null,
            comment: ''
          }
        ]
      },
      'db:routines': () => [
        {
          name: 'add',
          type: 'FUNCTION',
          definer: 'postgres',
          returns: 'integer',
          created: null,
          modified: null,
          comment: '',
          signature: 'a integer, b integer'
        },
        {
          name: 'add',
          type: 'FUNCTION',
          definer: 'postgres',
          returns: 'text',
          created: null,
          modified: null,
          comment: '',
          signature: 'a text, b text'
        }
      ]
    })
    await useConnectionsStore().load()
  })

  it('keeps MySQL ids and adds the database as one trailing segment for PostgreSQL', () => {
    expect(nodeIds.schema('c', 's')).toBe('s:c:s')
    expect(nodeIds.schema('c', 's', 'db')).toBe('s:c:s:db')
    expect(nodeIds.object('c', 's', 'tables', 't', 'shop:eu')).toBe('o:c:s:tables:t:shop%3Aeu')
    const tree = useTreeStore()
    const node = tree.parse(nodeIds.object('pg', 'public', 'tables', 'users', 'shop:eu'))!
    expect(node).toMatchObject({
      kind: 'object',
      database: 'shop:eu',
      schema: 'public',
      name: 'users'
    })
    expect(tree.parse(node.parentId!)).toMatchObject({ kind: 'group', database: 'shop:eu' })
    const schema = tree.parse(nodeIds.schema('pg', 'public', 'shop:eu'))!
    expect(tree.parse(schema.parentId!)).toMatchObject({ kind: 'database', database: 'shop:eu' })
    expect(tree.parse(nodeIds.schema('c', 's'))).not.toHaveProperty('database')
  })

  it('lists databases, then schemas, then groups, sending { database, schema }', async () => {
    const tree = useTreeStore()
    await tree.expand(tree.parse(nodeIds.connection('pg'))!)
    const dbs = tree.childrenOf(tree.parse(nodeIds.connection('pg'))!)
    expect(dbs.map((n) => [n.kind, n.label])).toEqual([
      ['database', 'app'],
      ['database', 'shop:eu']
    ])
    await tree.expand(dbs[1])
    expect(calls).toContainEqual(['db:schemas', 'pg', 'shop:eu'])
    const [schema] = tree.childrenOf(dbs[1])
    expect(schema).toMatchObject({ kind: 'schema', database: 'shop:eu', schema: 'public' })
    const tables = tree.parse(nodeIds.group('pg', 'public', 'tables', 'shop:eu'))!
    await tree.expand(tables)
    expect(calls).toContainEqual(['db:tables', 'pg', { database: 'shop:eu', schema: 'public' }])
    expect(tree.childrenOf(tables).map((n) => n.name)).toEqual(['users'])
    // The same schema in another database has its own cache.
    expect(tree.hasItems('pg', 'public', 'tables', 'app')).toBe(false)
  })

  it('names routine nodes with their signature so overloads stay apart', async () => {
    const tree = useTreeStore()
    const group = tree.parse(nodeIds.group('pg', 'public', 'functions', 'app'))!
    await tree.expand(group)
    expect(tree.childrenOf(group).map((n) => n.label)).toEqual([
      'add(a integer, b integer)',
      'add(a text, b text)'
    ])
  })
})
