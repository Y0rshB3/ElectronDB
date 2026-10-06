/**
 * Visual classification of a result column from its MySQL type name (as sent by
 * the main process, e.g. "INT UNSIGNED", "DECIMAL", "DATETIME"). Only used for
 * presentation: numbers are right aligned in mono, temporal values in mono.
 */
export type ColumnKind = 'number' | 'temporal' | 'text'

const NUMBER =
  /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|YEAR|BIT)\b/i
const TEMPORAL = /^(DATE|TIME|DATETIME|TIMESTAMP)\b/i

export function columnKind(type: string | null | undefined): ColumnKind {
  const t = (type ?? '').trim()
  if (NUMBER.test(t)) return 'number'
  if (TEMPORAL.test(t)) return 'temporal'
  return 'text'
}
