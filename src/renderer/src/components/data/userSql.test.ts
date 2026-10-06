import { describe, expect, it } from 'vitest'
import { friendlyError, isPrivilegeError } from './privileges'
import { grantAllSql, userActionSql, validateUserForm, type UserActionForm } from './userSql'

const form: UserActionForm = {
  user: 'app',
  host: '%',
  password: "s3cr'et",
  plugin: '',
  schema: 'shop',
  withGrantOption: false
}

describe('userSql', () => {
  it('masks passwords in the preview but not in the executed SQL', () => {
    expect(userActionSql('create', form, true)).toBe(
      "CREATE USER 'app'@'%' IDENTIFIED BY '********';"
    )
    expect(userActionSql('create', form)).toBe("CREATE USER 'app'@'%' IDENTIFIED BY 's3cr\\'et';")
    expect(userActionSql('create', { ...form, plugin: 'mysql_native_password' }, true)).toContain(
      'IDENTIFIED WITH `mysql_native_password`'
    )
  })

  it('builds grant, lock and drop statements', () => {
    expect(grantAllSql('app', '%', 'shop', true)).toBe(
      "GRANT ALL PRIVILEGES ON `shop`.* TO 'app'@'%' WITH GRANT OPTION;"
    )
    expect(grantAllSql('app', 'localhost', '*', false)).toBe(
      "GRANT ALL PRIVILEGES ON *.* TO 'app'@'localhost';"
    )
    expect(userActionSql('lock', form)).toBe("ALTER USER 'app'@'%' ACCOUNT LOCK;")
    expect(userActionSql('drop', form)).toBe("DROP USER 'app'@'%';")
  })

  it('validates required fields', () => {
    expect(validateUserForm('password', { ...form, password: '' })).toContain('contraseña')
    expect(validateUserForm('grant', { ...form, schema: '' })).toContain('base de datos')
    expect(validateUserForm('lock', form)).toBeNull()
  })

  it('explains privilege errors', () => {
    const raw =
      'Access denied; you need (at least one of) the CREATE USER privilege(s) for this operation (ER_SPECIFIC_ACCESS_DENIED_ERROR 1227)'
    expect(isPrivilegeError(raw)).toBe(true)
    expect(friendlyError(raw)).toContain('no tiene privilegios suficientes')
    expect(friendlyError('Duplicate entry (ER_DUP_ENTRY 1062)')).toBe(
      'Duplicate entry (ER_DUP_ENTRY 1062)'
    )
  })
})
