import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableStructure } from '@shared/types'
import { emptyColumn } from '@renderer/utils/tableDesigner'
import { COLUMN_TYPES } from '../columnType'
import {
  DROP_VERSIONING_RISK,
  KEEP_HISTORY_SQL,
  MARIADB_COLUMN_TYPES,
  mariadbBuildAlter,
  mariadbBuildCreate,
  mariadbDraftFromStructure,
  mariadbEmptyTable
} from './planner'

const col = (name: string, ordinal: number, columnType: string, key = ''): ColumnInfo => ({
  name,
  ordinal,
  columnType,
  dataType: columnType.replace(/\(.*$/, ''),
  nullable: key !== 'PRI',
  key,
  defaultValue: null,
  extra: '',
  characterSet: null,
  collation: null,
  comment: ''
})

// Shape of a MariaDB 11.8 system-versioned table (SHOW CREATE TABLE + information_schema).
const prices = (versioned: boolean): TableStructure => ({
  schema: 'shop',
  name: 'prices',
  tableType: versioned ? 'SYSTEM VERSIONED' : 'BASE TABLE',
  kind: versioned ? 'system-versioned' : 'table',
  columns: [col('id', 1, 'int(11)', 'PRI'), col('doc', 2, 'json'), col('ip', 3, 'inet6')],
  indexes: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'], comment: '' }],
  foreignKeys: [],
  engine: 'InnoDB',
  collation: 'utf8mb4_uca1400_ai_ci',
  comment: '',
  autoIncrement: null,
  createSql: [
    'CREATE TABLE `prices` (',
    '  `id` int(11) NOT NULL,',
    '  `doc` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`doc`)),',
    '  `ip` inet6 DEFAULT NULL,',
    '  PRIMARY KEY (`id`)',
    `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci${versioned ? ' WITH SYSTEM VERSIONING' : ''}`
  ].join('\n')
})

describe('MariaDB designer', () => {
  it('offers the MariaDB types after json and keeps every MySQL type', () => {
    expect(MARIADB_COLUMN_TYPES).toEqual(expect.arrayContaining(COLUMN_TYPES))
    const json = MARIADB_COLUMN_TYPES.indexOf('json')
    expect(MARIADB_COLUMN_TYPES.slice(json, json + 4)).toEqual(['json', 'uuid', 'inet4', 'inet6'])
  })

  it('starts a new table without the MySQL-only collation', () => {
    expect(mariadbEmptyTable()).toMatchObject({
      collation: '',
      options: { systemVersioning: false }
    })
  })

  it('creates a system-versioned table', () => {
    const draft = {
      ...mariadbEmptyTable(),
      name: 'h',
      columns: [{ ...emptyColumn(), name: 'id', columnType: 'uuid', nullable: false }],
      options: { systemVersioning: true }
    }
    expect(mariadbBuildCreate('shop', draft)).toBe(
      'CREATE TABLE `shop`.`h` (\n  `id` uuid NOT NULL\n) ENGINE=InnoDB WITH SYSTEM VERSIONING;'
    )
    expect(mariadbBuildCreate('shop', { ...draft, options: {} })).not.toContain('VERSIONING')
  })

  it('reads system versioning from the structure and changes nothing on a round trip', () => {
    for (const versioned of [true, false]) {
      const s = prices(versioned)
      const draft = mariadbDraftFromStructure(s)
      expect(draft.options?.systemVersioning).toBe(versioned)
      expect(draft.columns.map((c) => c.columnType)).toEqual(['int(11)', 'json', 'inet6'])
      expect(mariadbBuildAlter(s, draft).statements).toEqual([])
    }
  })

  it('keeps history while altering a versioned table', () => {
    const s = prices(true)
    const draft = mariadbDraftFromStructure(s)
    draft.columns.push({ ...emptyColumn(), name: 'note', columnType: 'varchar(20)' })
    const plan = mariadbBuildAlter(s, draft)
    expect(plan.statements[0]).toBe(KEEP_HISTORY_SQL)
    expect(plan.statements[1]).toContain('ADD COLUMN `note` varchar(20)')
  })

  it('adds and drops system versioning, warning that history is lost', () => {
    const plain = prices(false)
    const add = mariadbBuildAlter(plain, {
      ...mariadbDraftFromStructure(plain),
      options: { systemVersioning: true }
    })
    expect(add.statements).toEqual(['ALTER TABLE `shop`.`prices` ADD SYSTEM VERSIONING;'])
    expect(add.risks).toEqual([])

    const versioned = prices(true)
    const drop = mariadbBuildAlter(versioned, {
      ...mariadbDraftFromStructure(versioned),
      name: 'prices2',
      options: { systemVersioning: false }
    })
    expect(drop.statements).toEqual([
      KEEP_HISTORY_SQL,
      'ALTER TABLE `shop`.`prices` DROP SYSTEM VERSIONING;',
      'RENAME TABLE `shop`.`prices` TO `shop`.`prices2`;'
    ])
    expect(drop.risks).toContain(DROP_VERSIONING_RISK)
  })

  it('rebuilds a touched JSON column as json, which MariaDB re-checks with json_valid', () => {
    const s = prices(false)
    const draft = mariadbDraftFromStructure(s)
    draft.columns[1] = { ...draft.columns[1], comment: 'documento' }
    const [stmt] = mariadbBuildAlter(s, draft).statements
    expect(stmt).toContain("MODIFY COLUMN `doc` json NULL DEFAULT NULL COMMENT 'documento'")
  })
})
