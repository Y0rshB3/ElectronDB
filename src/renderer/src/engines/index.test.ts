import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { ENGINES } from '@shared/engines'
import { mysqlDialect } from '@shared/dialects'
import { vortaqMySQL } from '@renderer/components/common/editor/sqlCompletion'
import { buildDesignerAlter } from '@renderer/components/designer/alterTable'
import { ENGINES as TABLE_ENGINES } from '@renderer/components/designer/columnType'
import {
  buildDdlScript,
  ddlTemplate,
  isRename,
  parseObjectName
} from '@renderer/components/designer/ddl'
import { userActionSql } from '@renderer/components/data/userSql'
import { buildCreateTable, draftFromStructure, emptyTable } from '@renderer/utils/tableDesigner'
import { useConnectionsStore } from '@renderer/stores/connections'
import { installBridge, makeConnection, makeServerInfo } from '@renderer/__tests__/shellTestUtils'
import { engineUi, mysqlUi, postgresqlUi, sqliteUi, useEngine, useEngineUi } from './index'

describe('engine UI registry', () => {
  it('the MySQL module wraps today’s functions themselves (no copies)', () => {
    const ui = engineUi('mysql')
    expect(ui).toBe(mysqlUi)
    expect(engineUi()).toBe(mysqlUi)
    expect(ui.descriptor).toBe(ENGINES.mysql)
    expect(ui.dialect).toBe(mysqlDialect)
    expect(ui.editorLanguage).toBe(vortaqMySQL)
    expect(ui.designer).toEqual({
      emptyTable,
      draftFromStructure,
      buildCreate: buildCreateTable,
      buildAlter: buildDesignerAlter
    })
    expect(ui.designer!.buildAlter).toBe(buildDesignerAlter)
    expect(ui.typeCatalog!.tableEngines).toBe(TABLE_ENGINES)
    expect(ui.ddl).toEqual({
      template: ddlTemplate,
      buildScript: buildDdlScript,
      parseObjectName,
      isRename
    })
    expect(ui.userSql!.actionSql).toBe(userActionSql)
  })

  it('registers the PostgreSQL module (preview) with its own dialect and designer', () => {
    const ui = engineUi('postgresql')
    expect(ui).toBe(postgresqlUi)
    expect(ui.dialect?.id).toBe('postgresql')
    expect(ui.userSql).toBeNull()
  })

  it('registers the SQLite module (preview) with its own dialect and no users view', () => {
    const ui = engineUi('sqlite')
    expect(ui).toBe(sqliteUi)
    expect(ui.dialect?.id).toBe('sqlite')
    expect(ui.userSql).toBeNull()
  })

  it('refuses engines without a renderer module in this build', () => {
    expect(() => engineUi('mongodb')).toThrow(
      `${ENGINES.mongodb.label} todavía no está disponible en esta versión de Vortaq.`
    )
  })

  it('serves MariaDB with its own dialect, editor language and designer (P5)', () => {
    const ui = engineUi('mariadb')
    expect(ui.dialect?.id).toBe('mariadb')
    expect(ui.typeCatalog?.columnTypes).toEqual(expect.arrayContaining(['uuid', 'inet4', 'inet6']))
    expect(ui.userSql?.actionSql).toBe(engineUi('mysql').userSql?.actionSql)
    expect(ui.ddl?.template).toBe(engineUi('mysql').ddl?.template)
  })
})

describe('useEngine', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    installBridge({
      'connections:list': [
        makeConnection({ id: 'my' }),
        makeConnection({ id: 'pg', engine: 'postgresql' }),
        makeConnection({ id: 'lite', engine: 'sqlite' }),
        makeConnection({ id: 'mongo', engine: 'mongodb' })
      ],
      'connections:open': () =>
        makeServerInfo({
          runtime: { flavor: 'mysql', versionNumber: 80407, transactions: true, returning: 'none' }
        })
    })
    await useConnectionsStore().load()
  })

  it('follows the connection id and exposes runtime facts once open', async () => {
    const id = ref<string | null>('my')
    const engine = useEngine(id)
    expect(engine.value.descriptor?.id).toBe('mysql')
    expect(engine.value.ui).toBe(mysqlUi)
    expect(engine.value.runtime).toBeUndefined()
    await useConnectionsStore().open('my')
    expect(engine.value.runtime?.versionNumber).toBe(80407)

    id.value = 'pg'
    expect(engine.value.descriptor?.id).toBe('postgresql')
    expect(engine.value.capabilities?.hasSchemas).toBe(true)
    expect(engine.value.ui).toBe(postgresqlUi)

    id.value = 'lite'
    expect(engine.value.ui).toBe(sqliteUi)

    id.value = 'mongo'
    expect(engine.value.ui).toBeNull()

    id.value = null
    expect(engine.value.descriptor?.id).toBe('mysql')
  })

  it('useEngineUi throws the "not available" message for an engine without a module', () => {
    expect(useEngineUi('my').value).toBe(mysqlUi)
    expect(useEngineUi('pg').value).toBe(postgresqlUi)
    expect(useEngineUi('lite').value).toBe(sqliteUi)
    expect(() => useEngineUi('mongo').value).toThrow(
      'MongoDB todavía no está disponible en esta versión de Vortaq.'
    )
  })
})
