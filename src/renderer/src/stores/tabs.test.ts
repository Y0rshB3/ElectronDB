import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectionsStore } from './connections'
import { useQueriesStore } from './queries'
import { objectTabId, tabTitle, useTabsStore } from './tabs'
import { useWorkspace } from '@renderer/composables/useWorkspace'
import { installBridge, makeConnection } from '@renderer/__tests__/shellTestUtils'

describe('database on tabs (PostgreSQL-ready, unused by MySQL)', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    installBridge({ 'connections:list': [makeConnection({ id: 'c1', name: 'Dev' })] })
    await useConnectionsStore().load()
  })

  it('keeps MySQL ids and titles and leaves the tab without a database key', () => {
    expect(objectTabId('tableData', 'c1', undefined, 'shop', 'users')).toBe(
      'tableData:c1:shop:users'
    )
    expect(tabTitle('users', 'shop', 'Dev')).toBe('users@shop (Dev)')
    const ws = useWorkspace()
    ws.openTableData('c1', 'shop', 'users')
    ws.openTableDesigner('c1', 'shop', null)
    ws.openDdlEditor('c1', 'shop', 'view', 'v_users')
    ws.openDdlEditor('c1', 'shop', 'event', null)
    const tabs = useTabsStore().tabs.slice(1)
    expect(tabs.map((t) => [t.id.replace(/^tableDesigner-.*$/, 'anon'), t.title])).toEqual([
      ['tableData:c1:shop:users', 'users@shop (Dev)'],
      ['anon', 'Nueva tabla@shop (Dev)'],
      ['ddl:c1:shop:view:v_users', 'v_users@shop (Dev)'],
      [tabs[3].id, 'Nuevo event@shop (Dev)']
    ])
    for (const tab of tabs) expect('database' in tab).toBe(false)
  })

  it('separates the same schema.table in two databases', () => {
    const ws = useWorkspace()
    const tabs = useTabsStore()
    ws.openTableData('c1', 'public', 'users', 'app')
    ws.openTableData('c1', 'public', 'users', 'billing')
    ws.openTableData('c1', 'public', 'users', 'app')
    const opened = tabs.tabs.filter((t) => t.kind === 'tableData')
    expect(opened.map((t) => [t.id, t.title, t.database])).toEqual([
      ['tableData:c1:app:public:users', 'users@app.public (Dev)', 'app'],
      ['tableData:c1:billing:public:users', 'users@billing.public (Dev)', 'billing']
    ])
    expect(tabs.activeId).toBe('tableData:c1:app:public:users')
  })

  it('saved queries keep a database only when one is given', () => {
    const queries = useQueriesStore()
    const mysql = queries.save('c1', { name: 'A', sql: 'SELECT 1', schema: 'shop' })
    const pg = queries.save('c1', { name: 'B', sql: 'SELECT 1', schema: 'public', database: 'app' })
    expect('database' in mysql).toBe(false)
    expect(pg.database).toBe('app')
    const stored = JSON.parse(localStorage.getItem('electrondb.queries.c1') ?? '[]')
    expect(Object.keys(stored[0]).sort()).toEqual(['id', 'name', 'schema', 'sql', 'updatedAt'])
    expect(stored[1].database).toBe('app')
  })
})
