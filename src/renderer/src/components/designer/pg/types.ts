/**
 * PostgreSQL quoting helpers for the designer and the DDL editor, on top of
 * the shared dialect (src/shared/dialects/postgresql.ts): bare only for
 * lower-case [a-z_][a-z0-9_$]* names that are not reserved words.
 */
import { PG_RESERVED, quoteIdent } from '@shared/dialects/postgresql'

export { PG_RESERVED }

/** `"Name"` unless the name is a plain lower-case identifier that is not reserved. */
export function pgQuote(name: string): string {
  return quoteIdent(name)
}

/** `schema.name` with both parts quoted when needed; only `name` without a schema. */
export function pgQualified(schema: string | null | undefined, name: string): string {
  return schema ? `${pgQuote(schema)}.${pgQuote(name)}` : pgQuote(name)
}

/** Standard string literal ('' doubling; standard_conforming_strings is on). */
export function pgString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Type name without a trailing `[]` (one or more dimensions) plus whether it was an array. */
export function splitArrayType(type: string): { base: string; array: boolean } {
  const m = /^(.*?)((?:\s*\[\s*\d*\s*\])+)$/.exec(type.trim())
  return m ? { base: m[1].trim(), array: true } : { base: type.trim(), array: false }
}

/** Adds or removes the `[]` suffix of a type (the designer's "array" checkbox). */
export function withArray(type: string, array: boolean): string {
  const { base } = splitArrayType(type)
  return array ? `${base}[]` : base
}

/** Integer types an identity column accepts. */
export const IDENTITY_TYPES: ReadonlySet<string> = new Set([
  'smallint',
  'integer',
  'bigint',
  'int',
  'int2',
  'int4',
  'int8'
])

/** True for a serial column's default: nextval('…'::regclass). */
export function isNextvalDefault(value: string | null | undefined): boolean {
  return !!value && /^nextval\('(?:[^']|'')+'(?:::regclass)?\)$/i.test(value.trim())
}
