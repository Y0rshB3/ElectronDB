import { join } from 'node:path'
import { JsonStore } from '../storage/jsonStore'

export interface SecretCodec {
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export const plainCodec: SecretCodec = {
  encrypt: (p) => Buffer.from(p, 'utf8').toString('base64'),
  decrypt: (c) => Buffer.from(c, 'base64').toString('utf8')
}

export type CodecName = 'safeStorage' | 'plain'

interface SecretsDoc {
  version: number
  codec: CodecName
  items: Record<string, string>
}

export type SecretKind = 'mysql' | 'ssh' | 'ai'

export class CredentialStore {
  private store: JsonStore<SecretsDoc>

  constructor(
    dir: string,
    private readonly codec: SecretCodec,
    readonly codecName: CodecName = 'safeStorage'
  ) {
    this.store = new JsonStore(join(dir, 'credentials.json'), () => ({
      version: 1,
      codec: codecName,
      items: {}
    }))
  }

  private key(kind: SecretKind, id: string): string {
    return `${kind}:${id}`
  }

  has(kind: SecretKind, id: string): boolean {
    return this.key(kind, id) in this.store.get().items
  }

  get(kind: SecretKind, id: string): string | null {
    const cipher = this.store.get().items[this.key(kind, id)]
    if (cipher === undefined) return null
    return this.codec.decrypt(cipher)
  }

  set(kind: SecretKind, id: string, secret: string | null): void {
    const k = this.key(kind, id)
    this.store.update((d) => {
      if (secret === null || secret === '') delete d.items[k]
      else d.items[k] = this.codec.encrypt(secret)
    })
  }

  /** Codec recorded in credentials.json (may differ from ours for a copied file). */
  storedCodec(): CodecName {
    return this.store.get().codec
  }

  /** Encoded values as stored, keyed `<kind>:<id>` (profile migration only). */
  rawItems(): Record<string, string> {
    return { ...this.store.get().items }
  }

  /** Replaces every encoded value at once and records our codec (profile migration only). */
  replaceRaw(items: Record<string, string>): void {
    this.store.update((d) => {
      d.items = { ...items }
      d.codec = this.codecName
    })
  }

  /** Encodes a value with this store's codec without saving it. */
  encode(secret: string): string {
    return this.codec.encrypt(secret)
  }

  /** Decodes a value with this store's codec; throws when it does not belong to it. */
  decode(cipher: string): string {
    return this.codec.decrypt(cipher)
  }

  deleteAll(id: string): void {
    this.set('mysql', id, null)
    this.set('ssh', id, null)
  }
}
