import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_RECENT_SQLITE_FILES,
  forgetSqliteFile,
  recentSqliteFiles,
  rememberSqliteFile
} from './sqliteRecent'

describe('recent SQLite files', () => {
  afterEach(() => localStorage.clear())

  it('keeps the newest paths first, once, up to the limit', () => {
    expect(recentSqliteFiles()).toEqual([])
    rememberSqliteFile('/datos/a.db')
    rememberSqliteFile('/datos/b.db')
    rememberSqliteFile('/datos/a.db')
    expect(recentSqliteFiles()).toEqual(['/datos/a.db', '/datos/b.db'])
    for (let i = 0; i < 20; i++) rememberSqliteFile(`/datos/${i}.db`)
    expect(recentSqliteFiles()).toHaveLength(MAX_RECENT_SQLITE_FILES)
    expect(recentSqliteFiles()[0]).toBe('/datos/19.db')
    forgetSqliteFile('/datos/19.db')
    expect(recentSqliteFiles()[0]).toBe('/datos/18.db')
  })

  it('survives a damaged stored value', () => {
    localStorage.setItem('electrondb.sqlite.recentFiles', '{nope')
    expect(recentSqliteFiles()).toEqual([])
    localStorage.setItem('electrondb.sqlite.recentFiles', JSON.stringify(['/x.db', 3, '']))
    expect(recentSqliteFiles()).toEqual(['/x.db'])
  })
})
