import { describe, expect, it } from 'vitest'
import { splitStatements as sqliteSplit } from '@shared/dialects/sqlite'
import {
  sqliteBuildDdlScript,
  sqliteDdlTemplate,
  sqliteIsRename,
  sqliteParseObjectName
} from './sqliteDdl'

describe('SQLite DDL editor support', () => {
  it('reads view and trigger names in every quoting form', () => {
    expect(sqliteParseObjectName('CREATE VIEW v AS SELECT 1', 'view')).toBe('v')
    expect(
      sqliteParseObjectName('create temp view if not exists main."My View" as select 1', 'view')
    ).toBe('My View')
    expect(
      sqliteParseObjectName(
        '-- x\nCREATE TRIGGER [t 1] AFTER INSERT ON a BEGIN SELECT 1; END',
        'trigger'
      )
    ).toBe('t 1')
    expect(
      sqliteParseObjectName(
        'CREATE TRIGGER `a``b` BEFORE DELETE ON t BEGIN SELECT 1; END',
        'trigger'
      )
    ).toBe('a`b')
    expect(sqliteParseObjectName('SELECT 1', 'view')).toBeNull()
  })

  it('detects renames case-insensitively', () => {
    expect(sqliteIsRename('CREATE VIEW V AS SELECT 1', 'view', 'v')).toBe(false)
    expect(sqliteIsRename('CREATE VIEW w AS SELECT 1', 'view', 'v')).toBe(true)
    expect(sqliteIsRename('CREATE VIEW w AS SELECT 1', 'view', null)).toBe(false)
  })

  it('drops and recreates inside one transaction, trigger bodies kept whole', () => {
    const source =
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN\n  UPDATE a SET x = 1;\n  SELECT 2;\nEND;'
    const script = sqliteBuildDdlScript(source, {
      type: 'trigger',
      schema: 'aux',
      originalName: 'old t',
      removeDefiner: false
    })
    expect(script).toBe(
      'BEGIN;\nDROP TRIGGER IF EXISTS aux."old t";\nCREATE TRIGGER t AFTER INSERT ON a BEGIN\n  UPDATE a SET x = 1;\n  SELECT 2;\nEND;\nCOMMIT;'
    )
    expect(sqliteSplit(script)).toHaveLength(4)
    expect(
      sqliteBuildDdlScript('CREATE VIEW v AS SELECT 1', {
        type: 'view',
        schema: 'main',
        originalName: null,
        removeDefiner: false
      })
    ).toBe('BEGIN;\nCREATE VIEW v AS SELECT 1;\nCOMMIT;')
  })

  it('offers templates that parse', () => {
    expect(sqliteParseObjectName(sqliteDdlTemplate('view'), 'view')).toBe('nueva_vista')
    expect(sqliteParseObjectName(sqliteDdlTemplate('trigger'), 'trigger')).toBe('nuevo_trigger')
    expect(sqliteSplit(sqliteDdlTemplate('trigger'))).toHaveLength(1)
  })
})
