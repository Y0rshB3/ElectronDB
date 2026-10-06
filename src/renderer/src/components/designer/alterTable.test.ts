import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableStructure } from '@shared/types'
import { draftFromStructure, emptyColumn } from '@renderer/utils/tableDesigner'
import {
  buildDesignerAlter,
  parseCreateColumns,
  stableColumns,
  tokenizeDefinition
} from './alterTable'

function col(
  name: string,
  ordinal: number,
  columnType: string,
  nullable: boolean,
  defaultValue: string | null,
  extra: string,
  key = ''
): ColumnInfo {
  return {
    name,
    ordinal,
    columnType,
    dataType: columnType.replace(/\(.*$/, ''),
    nullable,
    key,
    defaultValue,
    extra,
    characterSet: null,
    collation: null,
    comment: ''
  }
}

// Metadata captured from MySQL 8.4 (SHOW CREATE TABLE + information_schema.COLUMNS).
const probe: TableStructure = {
  schema: 'shop',
  name: 'probe',
  columns: [
    col('id', 1, 'int', false, null, 'auto_increment', 'PRI'),
    col('uid', 2, 'char(36)', false, 'uuid()', 'DEFAULT_GENERATED'),
    col(
      'updated',
      3,
      'timestamp',
      false,
      'CURRENT_TIMESTAMP',
      'DEFAULT_GENERATED on update CURRENT_TIMESTAMP'
    ),
    col('a', 4, 'int', true, null, ''),
    col('total', 5, 'int', true, null, 'STORED GENERATED'),
    col(
      'label',
      6,
      'varchar(20)',
      false,
      "concat(_utf8mb4\\'x\\',_utf8mb4\\'y\\')",
      'DEFAULT_GENERATED'
    )
  ],
  indexes: [{ name: 'PRIMARY', unique: true, type: 'BTREE', columns: ['id'], comment: '' }],
  foreignKeys: [],
  engine: 'InnoDB',
  collation: 'utf8mb4_0900_ai_ci',
  comment: '',
  autoIncrement: null,
  createSql:
    "CREATE TABLE `probe` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `uid` char(36) NOT NULL DEFAULT (uuid()),\n  `updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  `a` int DEFAULT NULL,\n  `total` int GENERATED ALWAYS AS ((`a` * 2)) STORED,\n  `label` varchar(20) NOT NULL DEFAULT (concat(_utf8mb4'x',_utf8mb4'y')) COMMENT 'it''s',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci"
}

describe('tokenizeDefinition', () => {
  it('keeps groups, literals and function calls whole', () => {
    expect(
      tokenizeDefinition(
        "varchar(20) NOT NULL DEFAULT (concat(_utf8mb4'x',_utf8mb4'y')) COMMENT 'it''s'"
      )
    ).toEqual([
      'varchar(20)',
      'NOT',
      'NULL',
      'DEFAULT',
      "(concat(_utf8mb4'x',_utf8mb4'y'))",
      'COMMENT',
      "'it''s'"
    ])
  })

  it('parses the column lines of SHOW CREATE TABLE', () => {
    const cols = parseCreateColumns(probe.createSql)
    expect([...cols.keys()]).toEqual(['id', 'uid', 'updated', 'a', 'total', 'label'])
    expect(cols.get('updated')).toMatchObject({
      defaultClause: 'CURRENT_TIMESTAMP',
      onUpdate: 'CURRENT_TIMESTAMP'
    })
    expect(cols.get('total')?.generated).toBe('GENERATED ALWAYS AS ((`a` * 2)) STORED')
  })
})

describe('buildDesignerAlter', () => {
  it('returns no statements for an unchanged table', () => {
    expect(buildDesignerAlter(probe, draftFromStructure(probe)).statements).toEqual([])
  })

  it('inserting a column only adds it: shifted columns are not rebuilt', () => {
    const draft = draftFromStructure(probe)
    draft.columns.splice(1, 0, { ...emptyColumn(), name: 'nuevo', columnType: 'int' })
    const { statements, risks } = buildDesignerAlter(probe, draft)
    expect(statements).toEqual([
      'ALTER TABLE `shop`.`probe`\n  ADD COLUMN `nuevo` int NULL DEFAULT NULL AFTER `id`;'
    ])
    expect(risks).toEqual([])
  })

  it('moves a column with its server definition verbatim', () => {
    const draft = draftFromStructure(probe)
    const [total] = draft.columns.splice(4, 1)
    draft.columns.splice(1, 0, total)
    const [updated] = draft.columns.splice(3, 1)
    draft.columns.push(updated)
    expect(buildDesignerAlter(probe, draft).statements).toEqual([
      'ALTER TABLE `shop`.`probe`\n  ' +
        [
          'MODIFY COLUMN `total` int GENERATED ALWAYS AS ((`a` * 2)) STORED AFTER `id`',
          'MODIFY COLUMN `updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `label`'
        ].join(',\n  ') +
        ';'
    ])
  })

  it('picks the minimal set of columns to reposition', () => {
    const cols = ['a', 'b', 'c', 'd'].map((n) => ({ ...emptyColumn(), name: n, originalName: n }))
    const draft = [cols[0], cols[2], cols[1], cols[3]]
    expect([...stableColumns(cols, draft)].sort()).toHaveLength(3)
    expect(stableColumns(cols, [cols[3], cols[0], cols[1], cols[2]]).has('d')).toBe(false)
  })

  it('preserves special attributes when a column is edited', () => {
    const draft = draftFromStructure(probe)
    draft.columns[1].comment = 'clave pública'
    draft.columns[2].comment = 'auditoría'
    draft.columns[4].comment = 'doble'
    const sql = buildDesignerAlter(probe, draft).statements[0]
    expect(sql).toContain(
      "MODIFY COLUMN `uid` char(36) NOT NULL DEFAULT (uuid()) COMMENT 'clave pública'"
    )
    expect(sql).toContain(
      "MODIFY COLUMN `updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'auditoría'"
    )
    expect(sql).toContain(
      "MODIFY COLUMN `total` int GENERATED ALWAYS AS ((`a` * 2)) STORED NULL COMMENT 'doble'"
    )
  })

  it('wraps expression defaults from information_schema when SHOW CREATE is unavailable', () => {
    const bare = { ...probe, createSql: '' }
    const draft = draftFromStructure(bare)
    draft.columns[1].comment = 'x'
    draft.columns[2].comment = 'y'
    const sql = buildDesignerAlter(bare, draft).statements[0]
    expect(sql).toContain("MODIFY COLUMN `uid` char(36) NOT NULL DEFAULT (uuid()) COMMENT 'x'")
    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
  })

  it('refuses to rebuild a generated column whose expression is unknown', () => {
    const bare = { ...probe, createSql: '' }
    const draft = draftFromStructure(bare)
    draft.columns[4].comment = 'x'
    expect(buildDesignerAlter(bare, draft).problems[0]).toContain('"total"')
  })

  it('flags type narrowing, NOT NULL, drops and renames as risks', () => {
    const draft = draftFromStructure(probe)
    draft.columns[5].columnType = 'varchar(5)'
    draft.columns[3].nullable = false
    draft.columns.splice(4, 1)
    draft.name = 'probe2'
    const { statements, risks } = buildDesignerAlter(probe, draft)
    expect(statements[0]).toMatch(/^ALTER TABLE `shop`.`probe`\n {2}DROP COLUMN `total`,/)
    expect(statements.at(-1)).toBe('RENAME TABLE `shop`.`probe` TO `shop`.`probe2`;')
    expect(risks.join('\n')).toMatch(/elimina el campo "total"/)
    expect(risks.join('\n')).toMatch(/varchar\(20\) a varchar\(5\)/)
    expect(risks.join('\n')).toMatch(/"a" pasa a NOT NULL/)
    expect(risks.join('\n')).toMatch(/renombra la tabla/)
  })

  it('merges column clauses with index and option changes from the shared util', () => {
    const draft = draftFromStructure(probe)
    draft.columns[3].comment = 'x'
    draft.comment = 'tabla'
    draft.indexes.push({
      id: 'i1',
      originalName: null,
      name: 'idx_a',
      unique: false,
      type: 'BTREE',
      columns: ['a'],
      comment: ''
    })
    expect(buildDesignerAlter(probe, draft).statements).toEqual([
      "ALTER TABLE `shop`.`probe`\n  MODIFY COLUMN `a` int NULL DEFAULT NULL COMMENT 'x',\n  ADD INDEX `idx_a` (`a`) USING BTREE,\n  COMMENT='tabla';"
    ])
  })
})
