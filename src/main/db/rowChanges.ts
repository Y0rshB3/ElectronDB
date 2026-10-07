/**
 * Engine-neutral grid saves (docs/multi-engine-design.md, section 5.4): the
 * all-or-nothing loop of v0.1.0's mysql/rowChanges.ts, unchanged. Every
 * UPDATE/DELETE must hit exactly one row; any failure rolls the whole batch
 * back and names the change that failed (formatRowChangeFailure).
 *
 * The engine builds the statements and owns the transaction SQL: MySQL keeps
 * its builder and its START TRANSACTION / COMMIT / ROLLBACK text in
 * src/main/mysql/rowChanges.ts. The dialect-based builder (with RETURNING and
 * omitted defaults) arrives with the first engine that needs it (P2b).
 */
import { formatRowChangeFailure } from '@shared/rowChangeFailure'
import type { ApplyRowChangesResult, RowChange } from '@shared/types'

export interface RowChangeRunner<S> {
  begin(): Promise<void>
  execute(statement: S): Promise<{ affectedRows: number; insertId: number | null }>
  commit(): Promise<void>
  rollback(): Promise<void>
  /** Text of a statement for the result list (literals inlined, display only). */
  display(statement: S): string
  /** Spanish reason for a statement the server rejected; never repeats row values. */
  explainError(err: unknown): string
  /** The error thrown for a failed change; must not carry server text in a trusted class. */
  toError(message: string, cause?: unknown): Error
}

/**
 * Applies `statements` (one per change, same order) in one transaction.
 * A failure to begin propagates as is; any later failure rolls back first.
 */
export async function applyRowChangesAtomically<S>(
  changes: RowChange[],
  statements: S[],
  runner: RowChangeRunner<S>
): Promise<ApplyRowChangesResult> {
  const failure = (i: number, reason: string, cause?: unknown): Error =>
    runner.toError(formatRowChangeFailure(i, changes.length, changes[i].kind, reason), cause)

  const applied: string[] = []
  const insertIds: (number | null)[] = []
  await runner.begin()
  try {
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]
      let res: { affectedRows: number; insertId: number | null }
      try {
        res = await runner.execute(stmt)
      } catch (err) {
        throw failure(i, runner.explainError(err), err)
      }
      if (changes[i].kind !== 'insert' && res.affectedRows > 1)
        throw failure(i, `afectaría ${res.affectedRows} filas en lugar de una`)
      if (changes[i].kind !== 'insert' && res.affectedRows === 0)
        throw failure(
          i,
          'la fila ya no existe o su clave cambió desde que se cargó; recarga los datos e inténtalo de nuevo'
        )
      applied.push(runner.display(stmt))
      insertIds.push(changes[i].kind === 'insert' ? (res.insertId ?? null) : null)
    }
    await runner.commit()
  } catch (err) {
    await runner.rollback().catch(() => undefined)
    throw err
  }
  return { applied: applied.length, statements: applied, insertIds }
}
