/**
 * Recognises what a dump statement (or a dump line) does from its first
 * characters: CREATE of which object, USE, CREATE/ALTER DATABASE, writes.
 * Conditional comments (`/*!50001 … *\/`, `/*M!… *\/`) are unwrapped first,
 * because dump tools wrap parts of CREATE VIEW/TRIGGER/EVENT in them.
 */

export type DumpObjectKind =
  'Table' | 'View' | 'Procedure' | 'Function' | 'Trigger' | 'Event' | 'Database'

export type StatementInfo =
  | { kind: 'create'; object: DumpObjectKind; name: string }
  | { kind: 'use'; name: string }
  | { kind: 'alterDatabase'; name: string }
  | { kind: 'write' }
  | { kind: 'other' }

const NAME = '(`(?:[^`]|``)+`|"(?:[^"]|"")+"|[\\w$\\u0080-\\uffff]+)'
const ACCOUNT_PART = "(?:`(?:[^`]|``)*`|'(?:[^'\\\\]|\\\\.)*'|[^\\s@]+)"
const DEFINER = `DEFINER\\s*=\\s*${ACCOUNT_PART}\\s*@\\s*(?:\`(?:[^\`]|\`\`)*\`|'(?:[^'\\\\]|\\\\.)*'|[^\\s(]+)`

const CREATE_RE = new RegExp(
  '^CREATE\\s+' +
    '(?:OR\\s+REPLACE\\s+)?' +
    '(?:TEMPORARY\\s+)?' +
    '(?:ALGORITHM\\s*=\\s*\\w+\\s+)?' +
    `(?:${DEFINER}\\s+)?` +
    '(?:SQL\\s+SECURITY\\s+\\w+\\s+)?' +
    '(?:AGGREGATE\\s+)?' +
    '(TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT|DATABASE|SCHEMA)\\s+' +
    '(?:IF\\s+NOT\\s+EXISTS\\s+)?' +
    `(?:${NAME}\\s*\\.\\s*)?${NAME}`,
  'i'
)
/** mysqldump splits CREATE VIEW over lines: the `VIEW name AS` line on its own. */
const VIEW_LINE_RE = new RegExp(`^VIEW\\s+(?:${NAME}\\s*\\.\\s*)?${NAME}\\s+AS\\b`, 'i')
const USE_RE = new RegExp(`^USE\\s+${NAME}\\s*;?\\s*$`, 'i')
const ALTER_DB_RE = new RegExp(`^ALTER\\s+(?:DATABASE|SCHEMA)\\s+${NAME}`, 'i')
const WRITE_RE = /^(INSERT|REPLACE|UPDATE|DELETE|LOAD)\b/i

const OBJECT: Record<string, DumpObjectKind> = {
  TABLE: 'Table',
  VIEW: 'View',
  PROCEDURE: 'Procedure',
  FUNCTION: 'Function',
  TRIGGER: 'Trigger',
  EVENT: 'Event',
  DATABASE: 'Database',
  SCHEMA: 'Database'
}

/** Unquotes `name`, "name" or name. */
export function unquoteName(raw: string): string {
  if (raw.startsWith('`') && raw.endsWith('`')) return raw.slice(1, -1).replace(/``/g, '`')
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/""/g, '"')
  return raw
}

/** Drops leading whitespace, `-- `/`#` lines and plain block comments (not `/*!`). */
export function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('/*') && !s.startsWith('/*!') && !s.startsWith('/*M!')) {
      const end = s.indexOf('*/', 2)
      s = end < 0 ? '' : s.slice(end + 2)
    } else if (s.startsWith('#') || /^--(\s|$)/.test(s)) {
      const end = s.indexOf('\n')
      s = end < 0 ? '' : s.slice(end + 1)
    } else return s
  }
}

/**
 * The first `limit` characters of a statement as the server reads them:
 * leading comments removed, conditional-comment markers dropped, whitespace
 * collapsed. Only for classification and messages, never executed.
 */
export function statementHead(sql: string, limit = 600): string {
  return stripLeadingComments(sql)
    .slice(0, limit)
    .replace(/\/\*M?!\d*/g, ' ')
    .replace(/\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function classifyHead(head: string): StatementInfo {
  const create = CREATE_RE.exec(head)
  if (create)
    return { kind: 'create', object: OBJECT[create[1].toUpperCase()], name: unquoteName(create[3]) }
  const view = VIEW_LINE_RE.exec(head)
  if (view) return { kind: 'create', object: 'View', name: unquoteName(view[2]) }
  const use = USE_RE.exec(head)
  if (use) return { kind: 'use', name: unquoteName(use[1]) }
  const alter = ALTER_DB_RE.exec(head)
  if (alter) return { kind: 'alterDatabase', name: unquoteName(alter[1]) }
  if (WRITE_RE.test(head)) return { kind: 'write' }
  return { kind: 'other' }
}

export function classifyStatement(sql: string): StatementInfo {
  return classifyHead(statementHead(sql))
}

/** One-line excerpt of a statement for messages (comments removed). */
export function excerpt(sql: string, max: number): string {
  const text = stripLeadingComments(sql)
    .slice(0, max * 2)
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** `ALTER DATABASE <name>` with the name replaced (intoSchema mode). */
export function redirectAlterDatabase(sql: string, quotedTarget: string): string {
  return sql.replace(
    new RegExp(`(ALTER\\s+(?:DATABASE|SCHEMA)\\s+)${NAME}`, 'i'),
    (_m, head: string) => `${head}${quotedTarget}`
  )
}

/** Tool named in the first lines of a dump (descriptive, from the file's own text). */
export function detectTool(header: string): string | null {
  if (/phpMyAdmin SQL Dump/i.test(header)) return 'phpMyAdmin'
  if (/HeidiSQL/i.test(header)) return 'HeidiSQL'
  if (/^-- Adminer\b/im.test(header)) return 'Adminer'
  if (/DBeaver/i.test(header)) return 'DBeaver'
  if (/TablePlus/i.test(header)) return 'TablePlus'
  if (/MySQL Workbench/i.test(header)) return 'MySQL Workbench'
  if (/^-- MariaDB dump\b/im.test(header)) return 'mysqldump (MariaDB)'
  if (/^-- MySQL dump\b/im.test(header)) return 'mysqldump'
  if (/^-- Vortaq\b/im.test(header)) return 'Vortaq'
  return null
}
