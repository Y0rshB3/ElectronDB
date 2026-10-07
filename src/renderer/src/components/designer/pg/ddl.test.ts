import { describe, expect, it } from 'vitest'
import {
  pgBuildDdlScript,
  pgDdlSupport,
  pgDdlTemplate,
  pgIsRename,
  pgParseObjectName,
  pgParseObjectSchema,
  pgParseTriggerTable
} from './ddl'

const base = { schema: 'public', removeDefiner: false }

describe('pgParseObjectName', () => {
  it('reads plain, quoted and schema-qualified names', () => {
    expect(pgParseObjectName('CREATE VIEW v_items AS SELECT 1', 'view')).toBe('v_items')
    expect(pgParseObjectName('create or replace view "My View" as select 1', 'view')).toBe(
      'My View'
    )
    expect(pgParseObjectName('CREATE VIEW Sales.V_Top AS SELECT 1', 'view')).toBe('v_top')
    expect(pgParseObjectSchema('CREATE VIEW Sales.V_Top AS SELECT 1', 'view')).toBe('sales')
    expect(
      pgParseObjectName(
        'CREATE MATERIALIZED VIEW IF NOT EXISTS "a""b" AS SELECT 1',
        'materialized_view'
      )
    ).toBe('a"b')
    expect(pgParseObjectName('CREATE MATERIALIZED VIEW mv AS SELECT 1', 'view')).toBeNull()
    expect(pgParseObjectName('CREATE TRIGGER t1 BEFORE INSERT ON x', 'trigger')).toBe('t1')
    expect(pgParseObjectName('CREATE CONSTRAINT TRIGGER ct AFTER INSERT ON x', 'trigger')).toBe(
      'ct'
    )
    expect(pgParseObjectName('CREATE EVENT e', 'event')).toBeNull()
  })

  it('never reads names inside $$ bodies', () => {
    const fn = [
      'CREATE OR REPLACE FUNCTION app.calc(a integer) RETURNS integer LANGUAGE plpgsql AS $body$',
      'BEGIN CREATE FUNCTION other() ...; RETURN a; END;',
      '$body$'
    ].join('\n')
    expect(pgParseObjectName(fn, 'function')).toBe('calc')
    expect(pgParseObjectName('CREATE PROCEDURE p() AS $$ CREATE PROCEDURE q $$', 'procedure')).toBe(
      'p'
    )
  })

  it('finds the table of a trigger', () => {
    expect(
      pgParseTriggerTable('CREATE TRIGGER t BEFORE UPDATE OF a ON sales."Orders" FOR EACH ROW')
    ).toEqual({ schema: 'sales', table: 'Orders' })
    expect(
      pgParseTriggerTable('CREATE TRIGGER t AFTER DELETE ON items EXECUTE FUNCTION f()')
    ).toEqual({
      schema: null,
      table: 'items'
    })
  })

  it('detects renames', () => {
    expect(pgIsRename('CREATE VIEW v2 AS SELECT 1', 'view', 'v1')).toBe(true)
    expect(pgIsRename('CREATE VIEW v1 AS SELECT 1', 'view', 'v1')).toBe(false)
    expect(pgIsRename('CREATE VIEW v2 AS SELECT 1', 'view', null)).toBe(false)
  })
})

describe('pgBuildDdlScript', () => {
  it('views use CREATE OR REPLACE and drop the old name after a rename', () => {
    expect(
      pgBuildDdlScript('CREATE VIEW v AS SELECT 1;', { ...base, type: 'view', originalName: 'v' })
    ).toBe('CREATE OR REPLACE VIEW v AS SELECT 1;')
    expect(
      pgBuildDdlScript('CREATE OR REPLACE VIEW v2 AS SELECT 1', {
        ...base,
        type: 'view',
        originalName: 'Old'
      })
    ).toBe('CREATE OR REPLACE VIEW v2 AS SELECT 1;\nDROP VIEW IF EXISTS public."Old";')
  })

  it('routines keep their $$ body and drop the original signature on a rename', () => {
    const fn = 'CREATE FUNCTION f2(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a; $$;'
    expect(pgBuildDdlScript(fn, { ...base, type: 'function', originalName: null })).toBe(
      'CREATE OR REPLACE FUNCTION f2(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a; $$;'
    )
    expect(
      pgBuildDdlScript(fn, { ...base, type: 'function', originalName: 'f1', signature: 'integer' })
    ).toBe(
      'DROP FUNCTION IF EXISTS public.f1(integer);\nCREATE OR REPLACE FUNCTION f2(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a; $$;'
    )
    expect(
      pgBuildDdlScript('CREATE PROCEDURE p2() LANGUAGE sql AS $$ SELECT 1 $$', {
        ...base,
        type: 'procedure',
        originalName: 'p1'
      })
    ).toBe(
      'DROP PROCEDURE IF EXISTS public.p1;\nCREATE OR REPLACE PROCEDURE p2() LANGUAGE sql AS $$ SELECT 1 $$;'
    )
  })

  it('materialized views are dropped and created again', () => {
    expect(
      pgBuildDdlScript('CREATE MATERIALIZED VIEW mv AS SELECT 1 WITH DATA', {
        ...base,
        type: 'materialized_view',
        originalName: 'mv'
      })
    ).toBe(
      'DROP MATERIALIZED VIEW IF EXISTS public.mv;\nCREATE MATERIALIZED VIEW mv AS SELECT 1 WITH DATA;'
    )
    expect(
      pgBuildDdlScript('CREATE MATERIALIZED VIEW s.mv2 AS SELECT 1', {
        ...base,
        type: 'materialized_view',
        originalName: null
      })
    ).toBe('DROP MATERIALIZED VIEW IF EXISTS s.mv2;\nCREATE MATERIALIZED VIEW s.mv2 AS SELECT 1;')
  })

  it('triggers drop the original on its table before CREATE', () => {
    const trg = 'CREATE TRIGGER t2 BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION f();'
    expect(pgBuildDdlScript(trg, { ...base, type: 'trigger', originalName: 't1' })).toBe(
      'DROP TRIGGER IF EXISTS t1 ON public.items;\nCREATE TRIGGER t2 BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION f();'
    )
    expect(
      pgBuildDdlScript(trg, { ...base, type: 'trigger', originalName: 't1', table: 'Old Table' })
    ).toBe(
      'DROP TRIGGER IF EXISTS t1 ON public."Old Table";\nCREATE TRIGGER t2 BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION f();'
    )
  })

  it('refuses events', () => {
    expect(() => pgBuildDdlScript('x', { ...base, type: 'event', originalName: null })).toThrow(
      'PostgreSQL no tiene eventos programados.'
    )
  })
})

describe('pgDdlTemplate', () => {
  it('uses $$ bodies and no DELIMITER', () => {
    for (const type of ['view', 'materialized_view', 'function', 'procedure', 'trigger'] as const) {
      const t = pgDdlTemplate(type)
      expect(t).not.toMatch(/DELIMITER/)
      expect(pgParseObjectName(t, type)).toBeTruthy()
    }
    expect(pgDdlTemplate('function')).toMatch(/AS \$\$\n[\s\S]*\n\$\$;$/)
    expect(pgDdlSupport.template).toBe(pgDdlTemplate)
  })
})
