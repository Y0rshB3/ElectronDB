import { readFileSync } from 'node:fs'
import type { FetchLike } from './service'

/**
 * VORTAQ_UPDATES_FIXTURE=<json file> (screenshots/tests only, honoured only
 * with a scratch profile): answers the GitHub request with that file instead
 * of the network. `{ "httpStatus": 429 }` simulates an HTTP error.
 */
export function fixtureFetch(file: string): FetchLike {
  return async () => {
    const text = readFileSync(file, 'utf8')
    let status = 200
    try {
      const doc = JSON.parse(text) as { httpStatus?: unknown }
      if (typeof doc.httpStatus === 'number') status = doc.httpStatus
    } catch {
      /* malformed fixtures are served as-is, like a broken API answer */
    }
    return { status, text: async () => text }
  }
}
