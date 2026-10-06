import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearRaisedNotices,
  dismissRaisedNotice,
  NOTICES_FILE,
  raiseNotice,
  raisedNotices
} from './notices'

describe('raised notices', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'electrondb-notices-'))
    clearRaisedNotices()
  })
  afterEach(() => {
    clearRaisedNotices()
    rmSync(dir, { recursive: true, force: true })
  })

  const notice = (id: string) => ({ id, level: 'warning' as const, title: 't', message: 'm' })

  it('shows each notice until it is dismissed once, also on later starts', () => {
    raiseNotice(notice('a'))
    raiseNotice(notice('b'))
    expect(raisedNotices(dir).map((n) => n.id)).toEqual(['a', 'b'])
    dismissRaisedNotice(dir, 'a')
    expect(raisedNotices(dir).map((n) => n.id)).toEqual(['b'])
    expect(JSON.parse(readFileSync(join(dir, NOTICES_FILE), 'utf8'))).toEqual({ dismissed: ['a'] })

    // next start raises the same notices again: the dismissed one stays hidden
    clearRaisedNotices()
    raiseNotice(notice('a'))
    raiseNotice(notice('b'))
    expect(raisedNotices(dir).map((n) => n.id)).toEqual(['b'])
  })

  it('ignores ids it never raised (migration notices are handled elsewhere)', () => {
    dismissRaisedNotice(dir, 'reenter-passwords')
    expect(() => readFileSync(join(dir, NOTICES_FILE))).toThrow()
  })
})
