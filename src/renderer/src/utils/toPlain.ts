import { isProxy, isRef, toRaw, unref } from 'vue'

/**
 * Deep-copies a value into plain data that survives Electron's structured
 * clone. Vue reactive proxies (reactive(), ref() contents, Pinia state) make
 * ipcRenderer.invoke throw "An object could not be cloned".
 */
export function toPlain<T>(value: T): T {
  return copy(value, new WeakMap()) as T
}

function copy(value: unknown, seen: WeakMap<object, unknown>): unknown {
  const v = isRef(value) ? unref(value) : value
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v
  const raw = isProxy(v) ? toRaw(v) : v
  if (seen.has(raw)) return seen.get(raw)
  if (raw instanceof Date) return new Date(raw.getTime())
  if (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) return raw
  if (Array.isArray(raw)) {
    const out: unknown[] = []
    seen.set(raw, out)
    for (const item of raw) out.push(copy(item, seen))
    return out
  }
  const out: Record<string, unknown> = {}
  seen.set(raw, out)
  for (const [k, item] of Object.entries(raw as Record<string, unknown>)) {
    const c = copy(item, seen)
    if (c !== undefined) out[k] = c
  }
  return out
}
