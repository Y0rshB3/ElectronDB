import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { ENGINES } from '@shared/engines'
import { mysqlDialect } from '@shared/dialects'
import { electronDBMySQL } from '@renderer/components/common/editor/sqlCompletion'
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
import { engineUi, mysqlUi, useEngine, useEngineUi } from './index'

describe('engine UI registry', () => {
  it('the MySQL module wraps today’s functions themselves (no copies)', () => {
    const ui = engineUi('mysql')
    expect(ui).toBe(mysqlUi)
    expect(engineUi()).toBe(mysqlUi)
    expect(ui.descriptor).toBe(ENGINES.mysql)
    expect(ui.dialect).toBe(mysqlDialect)
    expect(ui.editorLanguage).toBe(electronDBMySQL)
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

  it('refuses engines without a renderer module in this build', () => {
    for (const id of ['mariadb', 'postgresql', 'sqlite', 'mongodb'] as const)
      expect(() => engineUi(id)).toThrow(
        `${ENGINES[id].label} todavía no está disponible en esta versión de ElectronDB.`
      )
  })
})

describe('useEngine', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    installBridge({
      'connections:list': [
        makeConnection({ id: 'my' }),
        makeConnection({ id: 'pg', engine: 'postgresql' })
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
    expect(engine.value.ui).toBeNull()

    id.value = null
    expect(engine.value.descriptor?.id).toBe('mysql')
  })

  it('useEngineUi throws the "not available" message for an engine without a module', () => {
    expect(useEngineUi('my').value).toBe(mysqlUi)
    expect(() => useEngineUi('pg').value).toThrow(
      'PostgreSQL todavía no está disponible en esta versión de ElectronDB.'
    )
  })
})
