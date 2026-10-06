import {
  alterPasswordSql,
  createUserSql,
  dropUserSql,
  lockUserSql,
  quoteIdent,
  quoteString
} from '@renderer/utils/sql'

export type UserAction = 'create' | 'password' | 'lock' | 'unlock' | 'grant' | 'drop'

export interface UserActionForm {
  user: string
  host: string
  password: string
  plugin: string
  schema: string
  withGrantOption: boolean
}

export const AUTH_PLUGINS = ['caching_sha2_password', 'mysql_native_password', 'sha256_password']

const MASK = '********'

export function grantAllSql(
  user: string,
  host: string,
  schema: string,
  withGrantOption: boolean
): string {
  const target = schema === '*' ? '*.*' : `${quoteIdent(schema)}.*`
  return `GRANT ALL PRIVILEGES ON ${target} TO ${quoteString(user)}@${quoteString(host)}${withGrantOption ? ' WITH GRANT OPTION' : ''};`
}

/**
 * SQL for a user administration action. With `masked` the password is
 * replaced so the preview never shows secrets on screen.
 */
export function userActionSql(action: UserAction, form: UserActionForm, masked = false): string {
  const password = masked && form.password ? MASK : form.password
  switch (action) {
    case 'create':
      return createUserSql(form.user, form.host, password, form.plugin || null)
    case 'password':
      return alterPasswordSql(form.user, form.host, password)
    case 'lock':
      return lockUserSql(form.user, form.host, true)
    case 'unlock':
      return lockUserSql(form.user, form.host, false)
    case 'grant':
      return grantAllSql(form.user, form.host, form.schema, form.withGrantOption)
    case 'drop':
      return dropUserSql(form.user, form.host)
  }
}

/** Returns a Spanish validation message, or null when the form is complete. */
export function validateUserForm(action: UserAction, form: UserActionForm): string | null {
  if (!form.user.trim()) return 'Indica el nombre de usuario'
  if (!form.host.trim()) return 'Indica el host (usa % para cualquiera)'
  if ((action === 'create' || action === 'password') && !form.password)
    return 'Indica la contraseña'
  if (action === 'grant' && !form.schema) return 'Selecciona la base de datos'
  return null
}
