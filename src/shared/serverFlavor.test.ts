import { describe, expect, it } from 'vitest'
import {
  detectMysqlFlavor,
  isMariaDbVersion,
  mysqlReturning,
  mysqlVersionNumber
} from './serverFlavor'

describe('serverFlavor', () => {
  it('detects MariaDB from VERSION(), also behind the 5.5.5- replication prefix', () => {
    expect(detectMysqlFlavor('11.8.9-MariaDB-ubu2404')).toBe('mariadb')
    expect(detectMysqlFlavor('5.5.5-10.6.12-MariaDB-log')).toBe('mariadb')
    expect(detectMysqlFlavor('8.4.7')).toBe('mysql')
    expect(detectMysqlFlavor('5.7.44-log')).toBe('mysql')
    expect(detectMysqlFlavor('')).toBe('mysql')
    expect(detectMysqlFlavor(undefined)).toBe('mysql')
    expect(isMariaDbVersion('10.11.6-MariaDB')).toBe(true)
  })

  it('numbers versions like server_version_num', () => {
    expect(mysqlVersionNumber('8.4.7')).toBe(80407)
    expect(mysqlVersionNumber('11.8.9-MariaDB-ubu2404')).toBe(110809)
    expect(mysqlVersionNumber('5.5.5-10.6.12-MariaDB')).toBe(100612)
    expect(mysqlVersionNumber('garbage')).toBe(0)
  })

  it('RETURNING only on MariaDB 10.5+', () => {
    expect(mysqlReturning('8.4.7')).toBe('none')
    expect(mysqlReturning('10.4.30-MariaDB')).toBe('none')
    expect(mysqlReturning('10.5.0-MariaDB')).toBe('insert-delete')
    expect(mysqlReturning('11.8.9-MariaDB')).toBe('insert-delete')
  })
})
