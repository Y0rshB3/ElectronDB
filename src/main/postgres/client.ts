/**
 * Builds pg clients (docs/multi-engine-design.md, section 5.6 PostgreSQL).
 *
 * - Config objects only, never connection strings (pg 8 would treat
 *   sslmode=require as verify-full and print a SECURITY WARNING).
 * - No ambient credentials (invariant 7): pg falls back to PGUSER, PGDATABASE,
 *   PGPASSWORD, ~/.pgpass, PGOPTIONS, PGSSLMODE, PGREPLICATION… whenever a
 *   config value is empty. Every one of them is set explicitly here, the
 *   password always goes through the function form (which skips env and
 *   pgpass), and the fields pg reads from the environment after the fact are
 *   overwritten on the client before it connects.
 * - Pinned session settings ride in the startup packet (`options`), so they
 *   are the session's reset values and survive DISCARD ALL.
 */
import { readFile } from 'node:fs/promises'
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from 'node:tls'
import pg from 'pg'
import type { ConnectionInput, SslMode } from '@shared/types'
import { DEFAULT_NETWORK, defaultPostgresOptions } from '@shared/engines'
import type { Endpoint } from '../db/driver'
import { PgUserError } from './errors'
import { pgTypes } from './values'

export const APPLICATION_NAME = 'Vortaq'

/**
 * Startup `-c` options: the fixed text forms the value-fidelity contract
 * relies on (section 2.2). Values contain no spaces, so no escaping is needed.
 */
export const PINNED_OPTIONS = [
  '-c DateStyle=ISO,MDY',
  '-c IntervalStyle=postgres',
  '-c extra_float_digits=3',
  '-c bytea_output=hex'
].join(' ')

/** Effective SSL mode: the stored one, or derived from the generic switches. */
export function sslModeOf(config: Pick<ConnectionInput, 'ssl'>): SslMode {
  const ssl = config.ssl
  if (ssl?.mode) return ssl.mode
  if (!ssl?.enabled) return 'disable'
  return ssl.verifyServer ? 'verify-full' : 'require'
}

export interface SslPlan {
  /** First attempt: false (no TLS) or the TLS options. */
  first: false | ConnectionOptions
  /**
   * Second attempt for 'allow' (retry with TLS when the server refuses
   * plaintext) and 'prefer' (retry without TLS when the server has none).
   */
  fallback: false | ConnectionOptions | null
  mode: SslMode
}

async function readPem(path: string | undefined, what: string): Promise<Buffer | undefined> {
  if (!path) return undefined
  try {
    return await readFile(path)
  } catch {
    throw new PgUserError(`No se pudo leer el archivo ${what} SSL en ${path}`)
  }
}

/**
 * TLS options per libpq mode (drivers §2.1). `servername` is the real host so
 * SNI and verify-full check the right certificate name through an SSH tunnel.
 */
export async function buildSslPlan(
  config: Pick<ConnectionInput, 'ssl' | 'host'>,
  endpoint: Endpoint,
  keyPassphrase: string | null = null
): Promise<SslPlan> {
  const mode = sslModeOf(config)
  if (mode === 'disable') return { first: false, fallback: null, mode }
  const ca = await readPem(config.ssl.caCertPath, 'CA')
  const cert = await readPem(config.ssl.clientCertPath, 'de certificado cliente')
  const key = await readPem(config.ssl.clientKeyPath, 'de clave cliente')
  const base: ConnectionOptions = {
    ...(ca ? { ca } : {}),
    ...(cert ? { cert } : {}),
    ...(key ? { key } : {}),
    ...(key && keyPassphrase ? { passphrase: keyPassphrase } : {})
  }
  const servername = endpoint.tlsServername ?? config.host
  // Node refuses an IP address as SNI servername; verification still uses it via checkServerIdentity.
  if (servername && !/^[\d.]+$|:/.test(servername)) base.servername = servername
  const noVerify: ConnectionOptions = { ...base, rejectUnauthorized: false }
  switch (mode) {
    case 'allow':
      return { first: false, fallback: noVerify, mode }
    case 'prefer':
      return { first: noVerify, fallback: false, mode }
    case 'require':
      return { first: noVerify, fallback: null, mode }
    case 'verify-ca':
      return {
        first: { ...base, rejectUnauthorized: true, checkServerIdentity: () => undefined },
        fallback: null,
        mode
      }
    case 'verify-full': {
      const host = endpoint.tlsServername ?? config.host
      return {
        first: {
          ...base,
          rejectUnauthorized: true,
          // Through a tunnel the socket goes to 127.0.0.1: verify the real host name.
          ...(endpoint.tlsServername
            ? {
                checkServerIdentity: (_h: string, c: PeerCertificate) =>
                  checkServerIdentity(host, c)
              }
            : {})
        },
        fallback: null,
        mode
      }
    }
  }
}

/** The first attempt failed in a way the mode allows to retry with the fallback. */
export function shouldRetrySsl(plan: SslPlan, err: unknown): boolean {
  if (plan.fallback === null) return false
  const message = err instanceof Error ? err.message : String(err)
  if (plan.mode === 'prefer') return /does not support SSL/i.test(message)
  // allow: plaintext refused by pg_hba ("no pg_hba.conf entry … no encryption").
  return /no encryption|SSL (?:connection )?(?:is )?required|requires SSL/i.test(message)
}

export interface ClientSpec {
  endpoint: Endpoint
  user: string
  database: string
  password: string | null
  ssl: false | ConnectionOptions
  connectTimeoutMs: number
  keepAliveSec: number
}

/** pg ClientConfig with every value explicit (no env, no pgpass). */
export function clientConfig(spec: ClientSpec): pg.ClientConfig {
  if (!spec.user) throw new PgUserError('La conexión PostgreSQL necesita un usuario')
  if (!spec.database) throw new PgUserError('Falta la base de datos de la conexión PostgreSQL')
  const secret = spec.password
  return {
    host: spec.endpoint.host,
    port: spec.endpoint.port,
    user: spec.user,
    database: spec.database,
    // Function form: pg never reads PGPASSWORD or ~/.pgpass for it.
    password: async () => secret ?? '',
    ssl: spec.ssl,
    sslnegotiation: 'postgres',
    application_name: APPLICATION_NAME,
    client_encoding: 'UTF8',
    options: PINNED_OPTIONS,
    connectionTimeoutMillis: spec.connectTimeoutMs,
    keepAlive: spec.keepAliveSec > 0,
    keepAliveInitialDelayMillis: spec.keepAliveSec * 1000,
    types: pgTypes
  } as pg.ClientConfig
}

/**
 * A pg Client whose ambient-derived fields are forced to the explicit values
 * (pg's `val()` reads PG* env vars for any falsy config value, including ones
 * like `replication` we never set).
 */
export function createClient(spec: ClientSpec): pg.Client {
  const client = new pg.Client(clientConfig(spec))
  const params = (client as unknown as { connectionParameters: Record<string, unknown> })
    .connectionParameters
  params.user = spec.user
  params.database = spec.database
  params.host = spec.endpoint.host
  params.port = spec.endpoint.port
  params.replication = undefined
  params.options = PINNED_OPTIONS
  params.application_name = APPLICATION_NAME
  params.client_encoding = 'UTF8'
  ;(client as unknown as { replication?: unknown }).replication = undefined
  return client
}

/** Network options with defaults (connect timeout, keepalive). */
export function networkOf(config: Pick<ConnectionInput, 'network'>): {
  connectTimeoutMs: number
  keepAliveSec: number
} {
  return { ...DEFAULT_NETWORK, ...config.network }
}

export function postgresOf(config: Pick<ConnectionInput, 'postgres'>) {
  return { ...defaultPostgresOptions(), ...config.postgres }
}

/** search_path list without duplicates, keeping order; quoting is the caller's job. */
export function composeSearchPath(first: string | null, rest: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of [first, ...rest]) {
    if (!s) continue
    const key = s
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * Parses a search_path setting (`"$user", public`, `app, "My Schema"`) into
 * names, keeping `$user` as written.
 */
export function parseSearchPath(text: string): string[] {
  const out: string[] = []
  let i = 0
  const s = text.trim()
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++
    if (i >= s.length) break
    if (s[i] === '"') {
      let j = i + 1
      let value = ''
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') {
            value += '"'
            j += 2
            continue
          }
          break
        }
        value += s[j++]
      }
      out.push(value)
      i = j + 1
    } else {
      let j = i
      while (j < s.length && s[j] !== ',') j++
      out.push(s.slice(i, j).trim())
      i = j
    }
  }
  return out.filter((x) => x.length > 0)
}

/** `"a", public` from names (each quoted with "" doubling, `$user` kept quoted as PG prints it). */
export function formatSearchPath(names: string[]): string {
  return names.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ')
}
