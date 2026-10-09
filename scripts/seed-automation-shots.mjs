/* global process, console, Buffer, URL */
/**
 * Seeds a scratch profile and the throwaway test servers for the job editor
 * screenshots (steps 45* of src/main/screenshots.ts): one job with steps on
 * MySQL, PostgreSQL, MongoDB and MariaDB, a restore step, a few past runs and
 * an encrypted copy (fixture password); for the «Restaurar paquete» steps 47*,
 * «Copias de Local» (six backup steps) and «Copia nocturna Staging» with one
 * past run whose copies are empty placeholder files in the scratch profile.
 *
 *   node scripts/seed-automation-shots.mjs
 *   npm run build
 *   VORTAQ_USER_DATA=$TMPDIR/vortaq-auto-shots/profile VORTAQ_PLAIN_SECRETS=1 \
 *   VORTAQ_SCREENSHOTS=$TMPDIR/vortaq-auto-shots VORTAQ_SHOTS_ONLY=45 npx electron .
 *
 * Env: VORTAQ_SHOTS_AUTO_PROFILE (scratch profile, wiped; must end in /profile),
 * VORTAQ_TEST_MYSQL_URL, VORTAQ_TEST_MARIADB_URL, VORTAQ_TEST_PG_URL,
 * VORTAQ_TEST_MONGO_URL (default: the compose containers). Creates the MySQL
 * databases `ventas` and `crm` (dropped first; the last 45 step drops them
 * again), `ventas`, `crm` and `auth` on MySQL 5.7 «Staging» for the «Copiar y
 * restaurar» steps 46* (the last 46 step drops them) and the MongoDB database `tienda_auto` (dropped first). Never touches ports 3306-3309 or
 * 5432 and never the real profile. Data is synthetic.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { MongoClient } from 'mongodb'

const env = (name) => process.env[`VORTAQ_${name}`] ?? process.env[`ELECTRONDB_${name}`]
const PROFILE = resolve(
  env('SHOTS_AUTO_PROFILE') || join(process.env.TMPDIR || '/tmp', 'vortaq-auto-shots', 'profile')
)
const MYSQL_URL = new URL(
  env('TEST_MYSQL_URL') || 'mysql://root:navidog@127.0.0.1:33306/navidog_test'
)
const MYSQL57_URL = new URL(
  env('TEST_MYSQL57_URL') || 'mysql://root:navidog@127.0.0.1:33357/navidog_test'
)
const MARIA_URL = new URL(
  env('TEST_MARIADB_URL') || 'mysql://root:navidog@127.0.0.1:33311/navidog_test'
)
const PG_URL = new URL(
  env('TEST_PG_URL') || 'postgres://postgres:navidog@127.0.0.1:55432/navidog_test'
)
const MONGO_URL = new URL(
  env('TEST_MONGO_URL') || 'mongodb://root:navidog@127.0.0.1:57017/?authSource=admin'
)

for (const u of [MYSQL_URL, MYSQL57_URL, MARIA_URL, PG_URL]) {
  const port = Number(u.port)
  if ((port >= 3306 && port <= 3309) || port === 5432) {
    console.error(`Refusing to seed a server on port ${port}: use the throwaway test containers.`)
    process.exit(1)
  }
}
if (basename(PROFILE) !== 'profile') {
  console.error(
    `Refusing to wipe ${PROFILE}: the scratch profile directory must be named "profile".`
  )
  process.exit(1)
}

/* ---------- servers ---------- */

const my = await mysql.createConnection({
  host: MYSQL_URL.hostname,
  port: Number(MYSQL_URL.port),
  user: decodeURIComponent(MYSQL_URL.username),
  password: decodeURIComponent(MYSQL_URL.password),
  multipleStatements: true
})
await my.query(`
  DROP DATABASE IF EXISTS ventas;
  CREATE DATABASE ventas;
  CREATE TABLE ventas.pedidos (id INT PRIMARY KEY, estado VARCHAR(20), total DECIMAL(10,2));
  INSERT INTO ventas.pedidos VALUES (1, 'pagado', 120.50), (2, 'pendiente', 42.00);
  DROP DATABASE IF EXISTS crm;
  CREATE DATABASE crm;
  CREATE TABLE crm.contactos (id INT PRIMARY KEY, nombre VARCHAR(40));
`)
await my.end()

// Staging 5.7: the databases «Copiar y restaurar» copies into Local (steps 46*).
const staging = await mysql.createConnection({
  host: MYSQL57_URL.hostname,
  port: Number(MYSQL57_URL.port),
  user: decodeURIComponent(MYSQL57_URL.username),
  password: decodeURIComponent(MYSQL57_URL.password),
  multipleStatements: true
})
await staging.query(`
  DROP DATABASE IF EXISTS ventas;
  CREATE DATABASE ventas;
  CREATE TABLE ventas.pedidos (id INT PRIMARY KEY, estado VARCHAR(20), total DECIMAL(10,2));
  INSERT INTO ventas.pedidos VALUES (1, 'pagado', 99.90);
  DROP DATABASE IF EXISTS crm;
  CREATE DATABASE crm;
  CREATE TABLE crm.contactos (id INT PRIMARY KEY, nombre VARCHAR(40));
  DROP DATABASE IF EXISTS auth;
  CREATE DATABASE auth;
  CREATE TABLE auth.usuarios (id INT PRIMARY KEY, email VARCHAR(80));
`)
await staging.end()

const mongo = new MongoClient(MONGO_URL.toString(), { serverSelectionTimeoutMS: 5000 })
await mongo.connect()
const tienda = mongo.db('tienda_auto')
await tienda.dropDatabase()
await tienda.collection('clientes').insertMany([
  { nombre: 'Ana Torres', ciudad: 'Lima' },
  { nombre: 'Bruno Díaz', ciudad: 'Quito' }
])
await mongo.close()

/* ---------- profile ---------- */

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(join(PROFILE, 'logs', 'jobs'), { recursive: true })
const now = new Date()
const iso = now.toISOString()
const daysAgo = (n, h = 2, m = 0) => {
  const d = new Date(now)
  d.setDate(d.getDate() - n)
  d.setHours(h, m, 0, 0)
  return d
}
const base = {
  color: null,
  savePassword: true,
  customDatabases: [],
  initialQueries: '',
  ssh: {
    enabled: false,
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    savePassword: false
  },
  ssl: { enabled: false, verifyServer: false },
  backupDir: join(PROFILE, 'backups'),
  extraBackupDirs: [],
  createdAt: iso,
  updatedAt: iso
}
const mysqlLike = (id, name, environment, color, url, engine = 'mysql') => ({
  ...base,
  id,
  name,
  color,
  environment,
  engine,
  host: url.hostname,
  port: Number(url.port),
  username: decodeURIComponent(url.username)
})
const PG_DB = decodeURIComponent(PG_URL.pathname.replace(/^\//, '')) || 'postgres'
const connections = [
  mysqlLike('shot-auto-local', 'Local Test', 'local', '#34d399', MYSQL_URL),
  mysqlLike('shot-auto-prod', 'Production Demo', 'production', '#f87171', MYSQL_URL),
  mysqlLike('shot-auto-staging', 'Staging 5.7', 'staging', '#fb923c', MYSQL57_URL),
  mysqlLike('shot-auto-maria', 'MariaDB Local', 'local', '#a78bfa', MARIA_URL, 'mariadb'),
  {
    ...base,
    id: 'shot-auto-pg',
    name: 'PostgreSQL Local',
    color: '#60a5fa',
    environment: 'local',
    engine: 'postgresql',
    host: PG_URL.hostname,
    port: Number(PG_URL.port),
    username: decodeURIComponent(PG_URL.username),
    ssl: { enabled: false, verifyServer: false, mode: 'prefer' },
    network: { connectTimeoutMs: 10000, keepAliveSec: 60 },
    postgres: { initialDatabase: PG_DB, showSystemSchemas: false, timeZone: '', searchPath: '' }
  },
  {
    ...base,
    id: 'shot-auto-mongo',
    name: 'Tienda (MongoDB)',
    color: '#4ade80',
    environment: 'staging',
    engine: 'mongodb',
    host: MONGO_URL.hostname,
    port: Number(MONGO_URL.port || 27017),
    username: decodeURIComponent(MONGO_URL.username),
    authMode: 'password',
    ssl: { enabled: false, verifyServer: true },
    network: { connectTimeoutMs: 5000, keepAliveSec: 60 },
    mongo: {
      topology: 'standalone',
      srv: false,
      members: [],
      replicaSet: '',
      authMechanism: 'default',
      authSource: MONGO_URL.searchParams.get('authSource') || 'admin',
      defaultDatabase: 'tienda_auto',
      readPreference: 'primary',
      directConnection: false,
      retryWrites: true,
      retryReads: true,
      extraOptions: {}
    }
  }
]
const passwordOf = (c) => {
  const url = {
    'shot-auto-staging': MYSQL57_URL,
    'shot-auto-maria': MARIA_URL,
    'shot-auto-pg': PG_URL,
    'shot-auto-mongo': MONGO_URL
  }[c.id]
  return decodeURIComponent((url ?? MYSQL_URL).password)
}

const task = (id, type, connectionId, schema, referenceName, extra = {}) => ({
  id,
  type,
  connectionId,
  schema,
  referenceName,
  ...extra
})
const MULTI = {
  id: 'shot-auto-multi',
  name: 'Copia nocturna multimotor',
  continueOnError: true,
  tasks: [
    task('m1', 'backupschema', 'shot-auto-local', 'ventas', 'Backup ventas', {
      includeData: true,
      format: 'vqb',
      encrypt: true
    }),
    task('m2', 'backupschema', 'shot-auto-pg', PG_DB, `Backup ${PG_DB} (PostgreSQL)`, {
      includeData: true,
      format: 'vqb'
    }),
    task('m3', 'backupschema', 'shot-auto-mongo', 'tienda_auto', 'Backup tienda_auto', {
      includeData: true,
      format: 'vqb'
    }),
    task('m4', 'runquery', 'shot-auto-maria', 'navidog_test', 'Purgar sesiones caducadas', {
      sql: 'DELETE FROM sesiones WHERE caducada < NOW() - INTERVAL 30 DAY;'
    }),
    task('m5', 'restoreschema', 'shot-auto-local', 'ventas_pruebas', 'Refrescar ventas_pruebas', {
      restoreSource: { kind: 'task', taskId: 'm1' },
      safetyBackup: true,
      includeData: true
    })
  ],
  schedule: { enabled: true, cron: '0 2 * * *', launchAgent: false },
  createdAt: iso,
  updatedAt: iso,
  lastRunAt: daysAgo(0).toISOString()
}

function run(id, job, status, started, seconds, statuses, message = null) {
  const finished = new Date(started.getTime() + seconds * 1000)
  return {
    id,
    jobId: job.id,
    jobName: job.name,
    status,
    trigger: 'schedule',
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    tasks: job.tasks.map((t, i) => ({
      taskId: t.id,
      referenceName: t.referenceName,
      status: statuses[i] ?? status,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      message: statuses[i] === 'failed' ? message : null,
      outputPath: null
    })),
    logPath: join(PROFILE, 'logs', 'jobs', `${id}.log`)
  }
}
const ok = ['success', 'success', 'success', 'success', 'success']
const runs = [
  run('auto-run-1', MULTI, 'success', daysAgo(0), 41, ok),
  run(
    'auto-run-2',
    MULTI,
    'failed',
    daysAgo(1),
    12,
    ['success', 'success', 'success', 'failed', 'success'],
    "Table 'navidog_test.sesiones' doesn't exist"
  ),
  run('auto-run-3', MULTI, 'success', daysAgo(2), 39, ok)
]

// «Restaurar paquete» screens (steps 47*): a job copying six databases of Local Test
// (its own package) and a backup-only job of Staging 5.7 whose last run is a package.
const LOCAL_DBS = ['ventas', 'crm', 'auth', 'facturas', 'inventario', 'logs']
const LOCAL_COPIES = {
  id: 'shot-auto-local-copies',
  name: 'Copias de Local',
  continueOnError: true,
  tasks: LOCAL_DBS.map((db, i) =>
    task(`l${i + 1}`, 'backupschema', 'shot-auto-local', db, `Copia de ${db} (Local Test)`, {
      includeData: db !== 'logs',
      format: 'vqb'
    })
  ),
  schedule: { enabled: true, cron: '30 1 * * *', launchAgent: false },
  createdAt: iso,
  updatedAt: iso,
  lastRunAt: null
}
const STAGING_DBS = ['ventas', 'crm', 'auth', 'pagos']
const STAGING_NIGHTLY = {
  id: 'shot-auto-staging-nightly',
  name: 'Copia nocturna Staging',
  continueOnError: true,
  tasks: STAGING_DBS.map((db, i) =>
    task(`s${i + 1}`, 'backupschema', 'shot-auto-staging', db, `Copia de ${db} (Staging 5.7)`, {
      includeData: true,
      format: 'vqb'
    })
  ),
  schedule: { enabled: true, cron: '0 3 * * *', launchAgent: false },
  createdAt: iso,
  updatedAt: iso,
  lastRunAt: daysAgo(0, 3).toISOString()
}
const nightlyStart = daysAgo(0, 3)
const stamp = nightlyStart.toISOString().replace(/[-:T]/g, '').slice(0, 14)
const nightlyRun = {
  ...run('auto-run-nightly', STAGING_NIGHTLY, 'success', nightlyStart, 18, []),
  trigger: 'schedule'
}
nightlyRun.tasks = STAGING_NIGHTLY.tasks.map((t) => {
  const dir = join(PROFILE, 'backups', t.schema)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${stamp}-copia-nocturna-staging.vqb`)
  writeFileSync(path, '')
  return {
    taskId: t.id,
    referenceName: t.referenceName,
    status: 'success',
    startedAt: nightlyStart.toISOString(),
    finishedAt: nightlyStart.toISOString(),
    message: null,
    outputPath: path,
    type: 'backupschema',
    connectionId: t.connectionId,
    schema: t.schema,
    includeData: true,
    format: 'vqb'
  }
})
runs.push(nightlyRun)

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const write = (name, data) =>
  writeFileSync(join(PROFILE, name), JSON.stringify(data, null, 2), { mode: 0o600 })
write('connections.json', { version: 1, items: connections })
write('credentials.json', {
  version: 1,
  codec: 'plain',
  items: {
    ...Object.fromEntries(connections.map((c) => [`mysql:${c.id}`, b64(passwordOf(c))])),
    // Fixture password of the encrypted step (never a real secret).
    'backupKey:shot-auto-multi': b64('fixture-password-1234')
  }
})
write('jobs.json', { version: 1, items: [MULTI, LOCAL_COPIES, STAGING_NIGHTLY] })
write('job-runs.json', { version: 1, items: runs })
write('settings.json', { theme: 'dark', checkUpdatesOnStartup: false })
for (const r of runs)
  writeFileSync(
    r.logPath,
    r.tasks
      .map(
        (t) =>
          `[${r.startedAt}] ${t.referenceName}: ${t.status}${t.message ? ` (${t.message})` : ''}`
      )
      .join('\n') + '\n',
    { mode: 0o600 }
  )
console.log(
  `Seeded ${PROFILE} (MySQL ventas/crm, 5.7 ventas/crm/auth, MongoDB tienda_auto, job ${MULTI.name})`
)
