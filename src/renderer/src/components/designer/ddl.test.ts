import { describe, expect, it } from 'vitest'
import { buildDdlScript, parseObjectName, stripDefiner } from './ddl'
import { joinColumnType, lengthForBase, splitColumnType } from './columnType'
import { validateDraft } from './validateDraft'
import { emptyColumn, emptyTable } from '@renderer/utils/tableDesigner'

describe('stripDefiner', () => {
  it('removes quoted, unquoted and CURRENT_USER definers', () => {
    expect(
      stripDefiner(
        'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS SELECT 1'
      )
    ).toBe('CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS SELECT 1')
    expect(stripDefiner("CREATE DEFINER='app'@'10.0.%' TRIGGER t")).toBe('CREATE TRIGGER t')
    expect(stripDefiner('CREATE DEFINER=root@localhost EVENT e')).toBe('CREATE EVENT e')
    expect(stripDefiner('CREATE DEFINER = CURRENT_USER() FUNCTION f')).toBe('CREATE FUNCTION f')
  })
})

describe('buildDdlScript', () => {
  it('uses CREATE OR REPLACE for views', () => {
    const script = buildDdlScript(
      'CREATE ALGORITHM=UNDEFINED DEFINER=`a`@`%` VIEW `v` AS SELECT 1;',
      {
        type: 'view',
        schema: 's',
        originalName: 'v',
        removeDefiner: true
      }
    )
    expect(script).toBe('CREATE OR REPLACE ALGORITHM=UNDEFINED VIEW `v` AS SELECT 1;')
  })

  it('creates new routines without DROP and avoids delimiter clashes', () => {
    const script = buildDdlScript('CREATE FUNCTION f() RETURNS TEXT RETURN "$$";', {
      type: 'function',
      schema: 's',
      originalName: null,
      removeDefiner: false
    })
    expect(script).toBe('DELIMITER //\nCREATE FUNCTION f() RETURNS TEXT RETURN "$$"//\nDELIMITER ;')
  })

  it('keeps DELIMITER scripts as written but still drops the original first', () => {
    const src = 'DELIMITER ;;\nCREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1;;\nDELIMITER ;'
    expect(
      buildDdlScript(src, { type: 'event', schema: 's', originalName: 'e', removeDefiner: false })
    ).toBe(`DROP EVENT IF EXISTS \`s\`.\`e\`;\n${src}`)
    expect(
      buildDdlScript(src, { type: 'event', schema: 's', originalName: null, removeDefiner: false })
    ).toBe(src)
  })

  it('honours Quitar DEFINER in DELIMITER scripts and does not duplicate their own DROP', () => {
    const src =
      'DROP PROCEDURE IF EXISTS `p`;\nDELIMITER $$\nCREATE DEFINER=`admin`@`%` PROCEDURE `p`()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;'
    const script = buildDdlScript(src, {
      type: 'procedure',
      schema: 's',
      originalName: 'p',
      removeDefiner: true
    })
    expect(script).not.toMatch(/DEFINER/)
    expect(script.match(/DROP PROCEDURE/g)).toHaveLength(1)
    expect(script).toContain('CREATE PROCEDURE `p`()')
  })

  it('drops the old view after creating it under a new name', () => {
    const script = buildDdlScript('CREATE VIEW `v2` AS SELECT 1', {
      type: 'view',
      schema: 's',
      originalName: 'v',
      removeDefiner: false
    })
    expect(script).toBe('CREATE OR REPLACE VIEW `v2` AS SELECT 1;\nDROP VIEW IF EXISTS `s`.`v`;')
  })

  it('parses object names from CREATE statements', () => {
    expect(parseObjectName('CREATE DEFINER=`a`@`%` PROCEDURE `shop`.`do it`()', 'procedure')).toBe(
      'do it'
    )
    expect(parseObjectName('CREATE TRIGGER trg_x BEFORE INSERT ON t', 'trigger')).toBe('trg_x')
  })
})

describe('column type helpers', () => {
  it('splits and joins types with lengths and enum lists', () => {
    expect(splitColumnType('varchar(255)')).toEqual({ base: 'varchar', length: '255', suffix: '' })
    expect(splitColumnType("enum('a','b')")).toEqual({
      base: 'enum',
      length: "'a','b'",
      suffix: ''
    })
    expect(joinColumnType({ base: 'decimal', length: '10,2', suffix: '' })).toBe('decimal(10,2)')
    expect(joinColumnType({ base: 'text', length: '', suffix: '' })).toBe('text')
    // MariaDB type names with digits stay whole, and take no length.
    expect(lengthForBase('inet6', '255')).toBe('')
    expect(lengthForBase('uuid', '36')).toBe('')
    expect(splitColumnType('inet6')).toEqual({ base: 'inet6', length: '', suffix: '' })
    expect(splitColumnType('inet4')).toEqual({ base: 'inet4', length: '', suffix: '' })
    expect(splitColumnType('int(11) unsigned')).toEqual({
      base: 'int',
      length: '11',
      suffix: 'unsigned'
    })
  })
})

describe('validateDraft', () => {
  it('reports duplicated and unnamed columns', () => {
    const draft = {
      ...emptyTable(),
      name: 't',
      columns: [
        { ...emptyColumn(), name: 'a' },
        { ...emptyColumn(), name: 'A' }
      ]
    }
    expect(validateDraft(draft)).toContain('repetido')
    expect(validateDraft({ ...draft, columns: [emptyColumn()] })).toContain('no tiene nombre')
    expect(validateDraft({ ...draft, name: '' })).toContain('nombre de la tabla')
  })
})
