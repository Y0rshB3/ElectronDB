/**
 * Minimal Blowfish (single-block ECB primitives) in plain TypeScript.
 *
 * Node's OpenSSL 3 build and Electron's BoringSSL do not expose the legacy
 * `bf-ecb` cipher, and the older .ncx password scheme (ncxCipher.ts) needs
 * it. The P-array and S-boxes are the hexadecimal digits of pi; they are
 * computed once on first use instead of embedding a 1042-entry table.
 */

const P_SIZE = 18
const S_SIZE = 4 * 256
const PI_HEX_DIGITS = (P_SIZE + S_SIZE) * 8

let piTable: Uint32Array | null = null

function arctanInverse(x: bigint, one: bigint): bigint {
  let sum = 0n
  let term = one / x
  const x2 = x * x
  let k = 1n
  let sign = 1n
  while (term !== 0n) {
    sum += sign * (term / k)
    term /= x2
    k += 2n
    sign = -sign
  }
  return sum
}

/** Hex digits of the fractional part of pi (Machin's formula, BigInt arithmetic). */
export function piFractionHex(digits: number): string {
  const guardBits = 64n
  const one = 1n << (BigInt(digits) * 4n + guardBits)
  const pi = 16n * arctanInverse(5n, one) - 4n * arctanInverse(239n, one)
  const fraction = (pi - 3n * one) >> guardBits
  return fraction.toString(16).padStart(digits, '0')
}

function initialTable(): Uint32Array {
  if (!piTable) {
    const hex = piFractionHex(PI_HEX_DIGITS)
    piTable = new Uint32Array(P_SIZE + S_SIZE)
    for (let i = 0; i < piTable.length; i++)
      piTable[i] = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0
  }
  return piTable
}

export class Blowfish {
  private readonly P: Uint32Array
  private readonly S: Uint32Array

  constructor(key: Uint8Array) {
    if (key.length < 1 || key.length > 56) throw new Error('Blowfish key must be 1..56 bytes')
    const table = initialTable()
    this.P = table.slice(0, P_SIZE)
    this.S = table.slice(P_SIZE)

    let k = 0
    for (let i = 0; i < P_SIZE; i++) {
      let word = 0
      for (let j = 0; j < 4; j++) {
        word = ((word << 8) | key[k]) >>> 0
        k = (k + 1) % key.length
      }
      this.P[i] = (this.P[i] ^ word) >>> 0
    }
    let l = 0
    let r = 0
    for (let i = 0; i < P_SIZE; i += 2) {
      ;[l, r] = this.encryptWords(l, r)
      this.P[i] = l
      this.P[i + 1] = r
    }
    for (let i = 0; i < S_SIZE; i += 2) {
      ;[l, r] = this.encryptWords(l, r)
      this.S[i] = l
      this.S[i + 1] = r
    }
  }

  private f(x: number): number {
    const S = this.S
    const a = S[x >>> 24]
    const b = S[256 + ((x >>> 16) & 0xff)]
    const c = S[512 + ((x >>> 8) & 0xff)]
    const d = S[768 + (x & 0xff)]
    return ((((a + b) >>> 0) ^ c) + d) >>> 0
  }

  private encryptWords(left: number, right: number): [number, number] {
    let l = left
    let r = right
    for (let i = 0; i < 16; i++) {
      l = (l ^ this.P[i]) >>> 0
      r = (r ^ this.f(l)) >>> 0
      ;[l, r] = [r, l]
    }
    ;[l, r] = [r, l]
    r = (r ^ this.P[16]) >>> 0
    l = (l ^ this.P[17]) >>> 0
    return [l, r]
  }

  private decryptWords(left: number, right: number): [number, number] {
    let l = left
    let r = right
    for (let i = 17; i > 1; i--) {
      l = (l ^ this.P[i]) >>> 0
      r = (r ^ this.f(l)) >>> 0
      ;[l, r] = [r, l]
    }
    ;[l, r] = [r, l]
    r = (r ^ this.P[1]) >>> 0
    l = (l ^ this.P[0]) >>> 0
    return [l, r]
  }

  /** Encrypts exactly one 8-byte block. */
  encryptBlock(block: Uint8Array): Buffer {
    const input = Buffer.from(block)
    const [l, r] = this.encryptWords(input.readUInt32BE(0), input.readUInt32BE(4))
    return toBlock(l, r)
  }

  /** Decrypts exactly one 8-byte block. */
  decryptBlock(block: Uint8Array): Buffer {
    const input = Buffer.from(block)
    const [l, r] = this.decryptWords(input.readUInt32BE(0), input.readUInt32BE(4))
    return toBlock(l, r)
  }
}

function toBlock(l: number, r: number): Buffer {
  const out = Buffer.alloc(8)
  out.writeUInt32BE(l, 0)
  out.writeUInt32BE(r, 4)
  return out
}
