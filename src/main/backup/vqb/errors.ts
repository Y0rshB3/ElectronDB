/**
 * Errors of the .vqb reader. Their messages reach the user as they are
 * (IPC errors surface as `message`), so they say what happened and what to do.
 */

/** Not a .vqb, an unsupported version or a damaged container. */
export class VqbFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VqbFormatError'
  }
}

export const PASSWORD_REQUIRED_MESSAGE =
  'La copia está cifrada: escribe su contraseña para abrirla.'
export const WRONG_PASSWORD_MESSAGE =
  'Contraseña incorrecta: no se puede descifrar la copia. Sin la contraseña correcta la copia no se puede recuperar.'

/** The archive is encrypted and the password is missing or wrong. */
export class VqbPasswordError extends Error {
  readonly code: 'VQB_PASSWORD_REQUIRED' | 'VQB_WRONG_PASSWORD'
  constructor(kind: 'required' | 'wrong') {
    super(kind === 'required' ? PASSWORD_REQUIRED_MESSAGE : WRONG_PASSWORD_MESSAGE)
    this.name = 'VqbPasswordError'
    this.code = kind === 'required' ? 'VQB_PASSWORD_REQUIRED' : 'VQB_WRONG_PASSWORD'
  }
}

/** A file does not match its checksum, or an encrypted chunk fails authentication. */
export class VqbIntegrityError extends Error {
  constructor(readonly path: string) {
    super(
      `La copia está dañada o ha sido modificada: falla la comprobación de integridad de ${path}.`
    )
    this.name = 'VqbIntegrityError'
  }
}

export const isPasswordError = (err: unknown): err is VqbPasswordError =>
  err instanceof VqbPasswordError ||
  (typeof (err as { code?: unknown })?.code === 'string' &&
    String((err as { code: string }).code).startsWith('VQB_') &&
    /PASSWORD/.test(String((err as { code: string }).code)))
