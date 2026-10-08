import { describe, expect, it } from 'vitest'
import { buildRebuildScript, qualifyCreate, rebuildPreview } from './rebuild'

describe('buildRebuildScript', () => {
  it('orders the 13 steps and restores the counter and foreign_keys', () => {
    const script = buildRebuildScript(
      {
        createBody: '(id INTEGER PRIMARY KEY AUTOINCREMENT, v)',
        columnMap: [
          { target: 'id', source: 'id' },
          { target: 'v', source: 'v' }
        ],
        keepRowid: false,
        indexes: ['CREATE INDEX "main".ix ON t (v)'],
        autoincrement: true
      },
      ['ALTER TABLE "main".old RENAME TO t'],
      {
        schema: 'main',
        table: 't',
        dependents: [
          {
            type: 'trigger',
            name: 'tr',
            sql: 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END'
          },
          { type: 'view', name: 'v_t', sql: 'CREATE VIEW v_t AS SELECT * FROM t' }
        ],
        sequence: 41,
        foreignKeys: true
      }
    )
    expect(script.pre).toEqual(['PRAGMA foreign_keys = OFF'])
    expect(script.body).toEqual([
      'BEGIN',
      'ALTER TABLE "main".old RENAME TO t',
      'DROP TRIGGER IF EXISTS "main"."tr"',
      'DROP VIEW IF EXISTS "main"."v_t"',
      'CREATE TABLE "main"."__vortaq_new_t" (id INTEGER PRIMARY KEY AUTOINCREMENT, v)',
      'INSERT INTO "main"."__vortaq_new_t" ("id", "v") SELECT "id", "v" FROM "main"."t"',
      'DROP TABLE "main"."t"',
      'ALTER TABLE "main"."__vortaq_new_t" RENAME TO "t"',
      'CREATE INDEX "main".ix ON t (v)',
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END',
      'CREATE VIEW v_t AS SELECT * FROM t',
      `UPDATE "main".sqlite_sequence SET seq = max(seq, 41) WHERE name = 't'`,
      `INSERT INTO "main".sqlite_sequence (name, seq) SELECT 't', 41 WHERE NOT EXISTS (SELECT 1 FROM "main".sqlite_sequence WHERE name = 't')`,
      'PRAGMA foreign_key_check',
      'COMMIT'
    ])
    expect(script.post).toEqual(['PRAGMA foreign_keys = ON'])
    expect(rebuildPreview(script)).toContain('-- Fuera de la transacción')
  })

  it('copies the rowid when both tables have one', () => {
    const script = buildRebuildScript(
      {
        createBody: '(a)',
        columnMap: [{ target: 'a', source: 'a' }],
        keepRowid: true,
        indexes: [],
        autoincrement: false
      },
      [],
      { schema: 'main', table: 't', dependents: [], sequence: null, foreignKeys: false }
    )
    expect(script.body).toContain(
      'INSERT INTO "main"."__vortaq_new_t" (rowid, "a") SELECT rowid, "a" FROM "main"."t"'
    )
    expect(script.post).toEqual(['PRAGMA foreign_keys = OFF'])
  })

  it('recreates the dependents and indexes of an attached database inside it', () => {
    expect(qualifyCreate('CREATE INDEX ix ON t (a)', 'aux')).toBe('CREATE INDEX "aux".ix ON t (a)')
    expect(qualifyCreate('create unique index if not exists "i x" on t(a)', 'aux')).toBe(
      'create unique index if not exists "aux"."i x" on t(a)'
    )
    expect(qualifyCreate('CREATE VIEW v AS SELECT 1', 'main')).toBe('CREATE VIEW v AS SELECT 1')
    expect(qualifyCreate('CREATE VIEW v AS SELECT 1', 'archivo')).toBe(
      'CREATE VIEW "archivo".v AS SELECT 1'
    )
    expect(qualifyCreate('CREATE TRIGGER aux.t AFTER INSERT ON x BEGIN SELECT 1; END', 'aux')).toBe(
      'CREATE TRIGGER aux.t AFTER INSERT ON x BEGIN SELECT 1; END'
    )
    expect(qualifyCreate('CREATE TEMP VIEW v AS SELECT 1', 'aux')).toBe(
      'CREATE TEMP VIEW v AS SELECT 1'
    )
    const script = buildRebuildScript(
      {
        createBody: '(a TEXT)',
        columnMap: [{ target: 'a', source: 'a' }],
        keepRowid: false,
        indexes: ['CREATE INDEX ix ON t (a)'],
        autoincrement: false
      },
      [],
      {
        schema: 'aux',
        table: 't',
        dependents: [{ type: 'view', name: 'v', sql: 'CREATE VIEW v AS SELECT a FROM t' }],
        sequence: null,
        foreignKeys: false
      }
    )
    expect(script.body).toContain('CREATE INDEX "aux".ix ON t (a)')
    expect(script.body).toContain('CREATE VIEW "aux".v AS SELECT a FROM t')
  })
})
