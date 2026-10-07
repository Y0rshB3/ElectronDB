import { backupFormatOfPath } from './naming'
import { VqbPasswordError } from './vqb/errors'
import { VqbReader } from './vqb/reader'

/**
 * Which of the passwords at hand opens a backup: null when it needs none
 * (.nb3, or a .vqb without encryption), the first candidate that unlocks an
 * encrypted .vqb otherwise. Throws VqbPasswordError (required / wrong) when
 * none does, so callers can tell the user before anything is touched.
 */
export async function pickBackupPassword(
  path: string,
  candidates: readonly (string | null | undefined)[]
): Promise<string | null> {
  if (backupFormatOfPath(path) !== 'vqb') return null
  const reader = await VqbReader.open(path)
  try {
    if (!reader.encrypted) return null
    const tried = new Set<string>()
    for (const candidate of candidates) {
      if (!candidate || tried.has(candidate)) continue
      tried.add(candidate)
      try {
        await reader.unlock(candidate)
        return candidate
      } catch (err) {
        if (!(err instanceof VqbPasswordError)) throw err
      }
    }
    throw new VqbPasswordError(tried.size ? 'wrong' : 'required')
  } finally {
    await reader.close()
  }
}
