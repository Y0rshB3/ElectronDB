/**
 * Loads `plist` lazily through a dynamic import: the package is ESM-only
 * (no `require` export condition) while the Electron main bundle is CJS.
 * A dynamic import from CJS resolves the `import` condition correctly.
 */
export type PlistDict = Record<string, unknown>

export const isPlistDict = (v: unknown): v is PlistDict =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Uint8Array) &&
  !(v instanceof Date)

/** Parses XML plist text. Throws when the document is not a valid plist. */
export async function parsePlistXml(xml: string): Promise<unknown> {
  const { parse } = await import('plist')
  return parse(xml)
}
