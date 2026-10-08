import { MariaSQL, SQLDialect } from '@codemirror/lang-sql'

/**
 * MariaDB words CodeMirror's MariaSQL dialect lacks: sequences, system
 * versioning and application periods, RETURNING, INVISIBLE columns, and the
 * MariaDB-only data types. They feed highlighting and keyword completion.
 */
export const MARIADB_EXTRA_KEYWORDS = [
  'returning',
  'sequence',
  'sequences',
  'increment',
  'minvalue',
  'nominvalue',
  'nomaxvalue',
  'cycle',
  'nocycle',
  'nocache',
  'restart',
  'system',
  'system_time',
  'versioning',
  'history',
  'period',
  'portion',
  'overlaps',
  'invisible',
  'without',
  'statement',
  'immediate',
  'compressed'
]

export const MARIADB_EXTRA_TYPES = ['uuid', 'inet4', 'inet6', 'json', 'vector']

export const MARIADB_EXTRA_BUILTINS = [
  'nextval',
  'lastval',
  'setval',
  'json_value',
  'json_query',
  'json_table',
  'json_valid',
  'json_detailed',
  'json_normalize',
  'sys_guid',
  'uuid_v4',
  'uuid_v7'
]

/**
 * MariaDB as the server parses it by default: CodeMirror's MariaSQL with
 * backslash escapes (like vortaqMySQL) and the words above.
 */
export const vortaqMariaSQL = SQLDialect.define({
  ...MariaSQL.spec,
  backslashEscapes: true,
  keywords: `${MariaSQL.spec.keywords ?? ''} ${MARIADB_EXTRA_KEYWORDS.join(' ')}`,
  types: `${MariaSQL.spec.types ?? ''} ${MARIADB_EXTRA_TYPES.join(' ')}`,
  builtin: `${MariaSQL.spec.builtin ?? ''} ${MARIADB_EXTRA_BUILTINS.join(' ')}`
})
