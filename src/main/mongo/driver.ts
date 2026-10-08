/**
 * MongoDB driver (docs/multi-engine-design.md, 5.6): the official `mongodb`
 * driver with credentials in `auth`, Vortaq's timeouts, TLS through the
 * tunnel's servername, member-role detection with `hello`.
 */
import { performance } from 'node:perf_hooks'
import { MongoClient } from 'mongodb'
import type { ConnectionConfig, ConnectionInput, ConnectionTestResult } from '@shared/types'
import type { Driver, DriverHooks, DriverSecrets, Endpoint } from '../db/driver'
import { buildClientPlan, mongoOf } from './client'
import { MongoDriverConnection, helloFacts, roleLabel, topologyLabel } from './connection'
import {
  MongoUserError,
  describeError,
  describeForLog,
  isAuthRejected,
  toServerError
} from './errors'

/** Connects a client and reads hello + buildInfo; closes it on failure. */
async function connectClient(
  config: ConnectionInput,
  secrets: DriverSecrets,
  endpoint: Endpoint | null
): Promise<{ client: MongoClient; version: string; hello: Record<string, unknown>; tls: boolean }> {
  const plan = await buildClientPlan(config, secrets, endpoint)
  const client = new MongoClient(plan.uri, plan.options)
  try {
    await client.connect()
    const admin = client.db('admin')
    const hello = await admin.command({ hello: 1 })
    let version = ''
    try {
      const info = await admin.command({ buildInfo: 1 })
      version = String(info.version ?? '')
    } catch {
      version = ''
    }
    return { client, version, hello, tls: plan.tls }
  } catch (err) {
    await client.close().catch(() => undefined)
    throw err
  }
}

export const mongoDriver: Driver = {
  engines: ['mongodb'],

  async test(
    input: ConnectionInput,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    startedAt: number
  ): Promise<ConnectionTestResult> {
    const { client, version, hello, tls } = await connectClient(input, secrets, endpoint)
    try {
      const facts = helloFacts(hello)
      // Listing databases checks that the credentials can do something useful.
      const mongo = mongoOf(input)
      let databases: number | null = null
      try {
        const list = await client
          .db('admin')
          .admin()
          .listDatabases({ nameOnly: true, authorizedDatabases: true })
        databases = list.databases.length
      } catch {
        databases = null
      }
      const details = [
        tls ? 'TLS' : 'sin cifrar',
        `${topologyLabel(facts.topology)}${facts.setName ? ` (${facts.setName})` : ''}`,
        `Miembro: ${roleLabel(facts.memberRole)}`
      ]
      if (databases !== null) details.push(`${databases} base(s) de datos visibles`)
      else if (mongo.defaultDatabase) details.push(`Base de datos: ${mongo.defaultDatabase}`)
      if (input.ssh.enabled) details.push(`Túnel SSH: ${input.ssh.host}`)
      if (facts.memberRole === 'secondary') details.push('Conectado a un secundario: solo lectura')
      return {
        ok: true,
        serverVersion: `MongoDB ${version}`.trim(),
        durationMs: Math.round(performance.now() - startedAt),
        details
      }
    } finally {
      await client.close().catch(() => undefined)
    }
  },

  async open(
    config: ConnectionConfig,
    secrets: DriverSecrets,
    endpoint: Endpoint | null,
    _hooks: DriverHooks
  ): Promise<MongoDriverConnection> {
    const { client, version, hello, tls } = await connectClient(config, secrets, endpoint)
    return new MongoDriverConnection({ config, client, version, facts: helloFacts(hello), tls })
  },

  describeForUser: (err) => describeError(err instanceof MongoUserError ? err : toServerError(err)),
  describeForLog: (err) => describeForLog(toServerError(err)),
  userError: (message) => new MongoUserError(message),
  isAuthRejected,
  missingPasswordError: (name) =>
    new MongoUserError(
      `La conexión ${name} necesita contraseña: escríbela en la conexión, o elige «Sin autenticación» si el servidor no la pide.`,
      'E_MONGO_NO_PASSWORD'
    )
}
