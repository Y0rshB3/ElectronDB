/* global process, console, Buffer, URL */
/**
 * Seeds a scratch profile and the throwaway test MySQL for the screenshot
 * harness (`npm run screenshots`). Never touches the real ElectronDB profile,
 * the real Navicat folder or MySQL on the usual local ports (3306-3309).
 *
 * Env:
 *   ELECTRONDB_SHOTS_PROFILE  scratch profile dir (default below; wiped and recreated)
 *   ELECTRONDB_SHOTS_MYSQL    mysql://user:pass@host:port/db (default throwaway container)
 *   ELECTRONDB_SHOTS_MYSQL57  same for the MySQL 5.7 "staging" of the rollback screens
 *                             (default throwaway 5.7 container on port 33357)
 * (the pre-rename NAVIDOG_SHOTS_* names are still accepted as a fallback)
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Must match the default in the `screenshots` npm script.
const env = (name) => process.env[`ELECTRONDB_${name}`] ?? process.env[`NAVIDOG_${name}`]
const DEFAULT_PROFILE = join(process.env.TMPDIR || '/tmp', 'electrondb-shots', 'profile')
const PROFILE = resolve(env('SHOTS_PROFILE') || DEFAULT_PROFILE)
// The throwaway test container keeps its original credentials and schema name.
const MYSQL_URL = env('SHOTS_MYSQL') || 'mysql://root:navidog@127.0.0.1:33306/navidog_test'

const MYSQL57_URL = env('SHOTS_MYSQL57') || 'mysql://root:navidog@127.0.0.1:33357/navidog_test'

const parseDb = (raw) => {
  const url = new URL(raw)
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, '') || 'navidog_test'
  }
}
const DB = parseDb(MYSQL_URL)
const DB57 = parseDb(MYSQL57_URL)

for (const db of [DB, DB57]) {
  if (db.port >= 3306 && db.port <= 3309) {
    console.error(`Refusing to seed MySQL on port ${db.port}: use the throwaway test instance.`)
    process.exit(1)
  }
}
if (basename(PROFILE) !== 'profile' || PROFILE === resolve(process.env.HOME || '/', 'profile')) {
  console.error(
    `Refusing to wipe ${PROFILE}: the scratch profile directory must be named "profile".`
  )
  process.exit(1)
}

/* ---------- profile ---------- */

const now = new Date()
const iso = (d) => d.toISOString()
const daysAgo = (n, h = 3, m = 0) => {
  const d = new Date(now)
  d.setDate(d.getDate() - n)
  d.setHours(h, m, 0, 0)
  return d
}

const backupsRoot = join(PROFILE, 'backups')
const ssh = {
  enabled: false,
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  savePassword: false
}
const ssl = { enabled: false, verifyServer: false }

function connection(id, name, environment, color, db = DB) {
  return {
    id,
    name,
    color,
    environment,
    host: db.host,
    port: db.port,
    username: db.user,
    savePassword: true,
    customDatabases: [],
    initialQueries: '',
    ssh,
    ssl,
    backupDir: join(backupsRoot, name),
    extraBackupDirs: [],
    createdAt: iso(daysAgo(30)),
    updatedAt: iso(daysAgo(2))
  }
}

const connections = [
  connection('shot-local', 'Local Test', 'local', '#34d399'),
  connection('shot-prod', 'Production Demo', 'production', '#f87171'),
  connection('shot-staging', 'Staging Demo', 'staging', '#fbbf24'),
  // The rollback screens back up this MySQL 5.7 "staging" and restore it into Local Test (8.4).
  connection('shot-staging57', 'Staging 5.7', 'staging', '#fb923c', DB57)
]
const passwordOf = (c) => (c.port === DB57.port && c.host === DB57.host ? DB57 : DB).password

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const credentials = {
  version: 1,
  codec: 'plain',
  items: {
    ...Object.fromEntries(connections.map((c) => [`mysql:${c.id}`, b64(passwordOf(c))])),
    // Fake key for the AI screens (answered by ELECTRONDB_AI_FIXTURE, never sent anywhere).
    'ai:shot-ai-claude': b64('sk-ant-fixture-not-a-real-key')
  }
}

/* AI assistant (steps 20*): providers, memory and one saved conversation. */
const aiProviders = {
  version: 1,
  items: [
    {
      id: 'shot-ai-claude',
      name: 'Claude',
      type: 'anthropic',
      baseUrl: '',
      model: 'claude-opus-5-5',
      createdAt: iso(daysAgo(3)),
      updatedAt: iso(daysAgo(3))
    },
    {
      id: 'shot-ai-ollama',
      name: 'Ollama local',
      type: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen-coder',
      createdAt: iso(daysAgo(2)),
      updatedAt: iso(daysAgo(2))
    }
  ]
}
const aiMemory = {
  version: 1,
  connections: {
    'shot-local': {
      notes: 'Los importes están en euros con IVA incluido.',
      databases: {
        [DB.database]:
          "shot_orders.status: 'pending' = sin pagar, 'paid' = cobrado, 'cancelled' = anulado por el cliente."
      }
    }
  }
}

const task = (id, type, connectionId, schema, referenceName, extra = {}) => ({
  id,
  type,
  connectionId,
  schema,
  referenceName,
  ...extra
})

const jobs = [
  {
    id: 'shot-job-local',
    name: 'Backup Local',
    continueOnError: true,
    tasks: [
      task('t1', 'backupschema', 'shot-local', DB.database, `Backup ${DB.database}`, {
        includeData: true
      }),
      task('t2', 'runquery', 'shot-local', DB.database, 'Purgar pedidos cancelados', {
        sql: "DELETE FROM shot_orders WHERE status = 'cancelled' AND created_at < NOW() - INTERVAL 2 YEAR;"
      })
    ],
    schedule: { enabled: true, cron: '0 3 * * *', launchAgent: false },
    createdAt: iso(daysAgo(20)),
    updatedAt: iso(daysAgo(1)),
    lastRunAt: iso(daysAgo(0, 3)),
    source: { app: 'navicat', fileName: 'Backup dev.nbatmysql', importedAt: iso(daysAgo(20)) }
  },
  {
    id: 'shot-job-prod',
    name: 'Backup prod',
    continueOnError: false,
    tasks: [
      task('t1', 'backupschema', 'shot-prod', 'shop', 'Backup shop', { includeData: true }),
      task('t2', 'backupschema', 'shot-prod', 'billing', 'Backup billing', { includeData: true }),
      task('t3', 'backupschema', 'shot-prod', 'accounts', 'Backup accounts', { includeData: true })
    ],
    schedule: { enabled: true, cron: '30 2 * * 1-5', launchAgent: false },
    createdAt: iso(daysAgo(20)),
    updatedAt: iso(daysAgo(5)),
    lastRunAt: iso(daysAgo(1, 2, 30)),
    source: { app: 'navicat', fileName: 'backup prod.nbatmysql', importedAt: iso(daysAgo(20)) }
  },
  {
    // «Restaurar todo en Local» screens: its run is restored into Local Test.
    id: 'shot-job-rollback',
    name: 'Backup staging 5.7',
    continueOnError: true,
    tasks: [
      task('r1', 'backupschema', 'shot-staging57', 'rb_shop', 'Backup rb_shop', {
        includeData: true
      }),
      task('r2', 'backupschema', 'shot-staging57', 'rb_crm', 'Backup rb_crm', { includeData: true })
    ],
    schedule: { enabled: false, cron: '', launchAgent: false },
    createdAt: iso(daysAgo(3)),
    updatedAt: iso(daysAgo(3)),
    lastRunAt: null
  },
  {
    // A job that backs up staging and restores it into Local in the same run.
    id: 'shot-job-staging-local',
    name: 'Staging 5.7 -> Local',
    continueOnError: false,
    tasks: [
      task('s1', 'backupschema', 'shot-staging57', 'rb_crm', 'Backup rb_crm', {
        includeData: true
      }),
      task('s2', 'restoreschema', 'shot-local', '', 'Restaurar rb_crm en Local', {
        restoreSource: { kind: 'task', taskId: 's1' },
        safetyBackup: true
      })
    ],
    schedule: { enabled: true, cron: '0 6 * * 1-5', launchAgent: false },
    createdAt: iso(daysAgo(3)),
    updatedAt: iso(daysAgo(3)),
    lastRunAt: null
  },
  {
    id: 'shot-job-staging',
    name: 'Backup staging',
    continueOnError: true,
    tasks: [task('t1', 'backupschema', 'shot-staging', 'shop', 'Backup shop')],
    schedule: { enabled: false, cron: '0 4 * * 0', launchAgent: false },
    createdAt: iso(daysAgo(20)),
    updatedAt: iso(daysAgo(9)),
    lastRunAt: null,
    source: { app: 'navicat', fileName: 'Backup staging.nbatmysql', importedAt: iso(daysAgo(20)) }
  }
]

function run(id, job, status, started, seconds, taskStatuses, message = null) {
  const finished = new Date(started.getTime() + seconds * 1000)
  return {
    id,
    jobId: job.id,
    jobName: job.name,
    status,
    trigger: 'schedule',
    startedAt: iso(started),
    finishedAt: iso(finished),
    tasks: job.tasks.map((t, i) => ({
      taskId: t.id,
      referenceName: t.referenceName,
      status: taskStatuses[i] ?? status,
      startedAt: iso(started),
      finishedAt: iso(finished),
      message: taskStatuses[i] === 'failed' ? message : null,
      outputPath: null
    })),
    logPath: join(PROFILE, 'logs', 'jobs', `${id}.log`)
  }
}

const runs = [
  run('run-1', jobs[0], 'success', daysAgo(0, 3), 14, ['success', 'success']),
  run('run-2', jobs[0], 'success', daysAgo(1, 3), 12, ['success', 'success']),
  run(
    'run-3',
    jobs[0],
    'failed',
    daysAgo(2, 3),
    4,
    ['success', 'failed'],
    'Lock wait timeout exceeded; try restarting transaction'
  ),
  run('run-4', jobs[1], 'success', daysAgo(1, 2, 30), 312, ['success', 'success', 'success']),
  run('run-5', jobs[1], 'success', daysAgo(2, 2, 30), 298, ['success', 'success', 'success'])
]

const settings = {
  navicatRootPath: join(ROOT, 'tests', 'fixtures', 'navicat'),
  backupsRootDir: backupsRoot,
  defaultRowLimit: 1000,
  theme: 'dark',
  confirmProductionWrites: true,
  confirmDestructiveEverywhere: true,
  checkUpdatesOnStartup: true,
  aiEnabled: true,
  aiDefaultProviderId: 'shot-ai-claude',
  aiEffort: 'low',
  aiMaxTokens: 16000
}

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(join(PROFILE, 'logs', 'jobs'), { recursive: true })
const writeJson = (name, data) =>
  writeFileSync(join(PROFILE, name), JSON.stringify(data, null, 2), { mode: 0o600 })
writeJson('connections.json', { version: 1, items: connections })
writeJson('credentials.json', credentials)
writeJson('jobs.json', { version: 1, items: jobs })
writeJson('job-runs.json', { version: 1, items: runs })
writeJson('settings.json', settings)
writeJson('ai-providers.json', aiProviders)
writeJson('ai-memory.json', aiMemory)
for (const r of runs)
  writeFileSync(r.logPath, `[${r.startedAt}] ${r.jobName}: ${r.status}\n`, { mode: 0o600 })

// Backups: the demo fixture copied under several Navicat-style names.
const fixtureDir = join(ROOT, 'tests', 'fixtures', 'navicat', 'backups', 'demo')
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith('.nb3'))
const localBackups = join(connections[0].backupDir, DB.database)
mkdirSync(localBackups, { recursive: true })
const stamp = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`
for (const f of fixtures) copyFileSync(join(fixtureDir, f), join(localBackups, f))
if (fixtures[0]) {
  const src = join(fixtureDir, fixtures[0])
  copyFileSync(src, join(localBackups, `${stamp(daysAgo(0, 3))}.nb3`))
  copyFileSync(src, join(localBackups, `${stamp(daysAgo(1, 3))}.nb3`))
  copyFileSync(src, join(localBackups, `${stamp(daysAgo(6, 18, 42))}-antes de migrar.nb3`))
}

/* ---------- MySQL ---------- */

let seed = 20261005
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = (list) => list[Math.floor(rand() * list.length)]

const FIRST = [
  'Lucía',
  'Mateo',
  'Sofía',
  'Hugo',
  'Martina',
  'Leo',
  'Valeria',
  'Daniel',
  'Paula',
  'Álvaro',
  'Elena',
  'Pablo',
  'Carmen',
  'Diego',
  'Noa',
  'Adrián'
]
const LAST = [
  'García',
  'Martín',
  'López',
  'Sánchez',
  'Romero',
  'Navarro',
  'Torres',
  'Domínguez',
  'Vázquez',
  'Ramos',
  'Gil',
  'Serrano',
  'Molina',
  'Ortega'
]
const PLACES = [
  ['ES', 'Madrid'],
  ['ES', 'Valencia'],
  ['ES', 'Sevilla'],
  ['MX', 'Guadalajara'],
  ['AR', 'Córdoba'],
  ['CO', 'Medellín'],
  ['CL', 'Valparaíso'],
  ['PE', 'Arequipa']
]
const STATUSES = ['pending', 'paid', 'paid', 'shipped', 'shipped', 'shipped', 'cancelled']

const conn = await mysql.createConnection({
  host: DB.host,
  port: DB.port,
  user: DB.user,
  password: DB.password,
  multipleStatements: true
})
try {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB.database}\``)
  await conn.query(`USE \`${DB.database}\``)
  await conn.query(`
    DROP VIEW IF EXISTS shot_customer_totals;
    DROP TABLE IF EXISTS shot_orders;
    DROP TABLE IF EXISTS shot_customers;
    CREATE TABLE shot_customers (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(80) NOT NULL,
      email VARCHAR(120) NOT NULL,
      country CHAR(2) NOT NULL,
      city VARCHAR(60) NOT NULL,
      credit_limit DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_shot_customers_email (email),
      KEY idx_shot_customers_country (country)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Clientes de demostración';
    CREATE TABLE shot_orders (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      customer_id INT UNSIGNED NOT NULL,
      status ENUM('pending','paid','shipped','cancelled') NOT NULL DEFAULT 'pending',
      items SMALLINT UNSIGNED NOT NULL DEFAULT 1,
      total DECIMAL(10,2) NOT NULL,
      notes VARCHAR(255) NULL,
      created_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY idx_shot_orders_customer (customer_id),
      KEY idx_shot_orders_created (created_at),
      CONSTRAINT fk_shot_orders_customer FOREIGN KEY (customer_id) REFERENCES shot_customers (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Pedidos de demostración';
  `)

  const customers = []
  for (let i = 1; i <= 200; i++) {
    const first = pick(FIRST)
    const last = pick(LAST)
    const [country, city] = pick(PLACES)
    const created = new Date(Date.UTC(2024, 0, 1) + Math.floor(rand() * 640) * 86400000)
    customers.push([
      `${first} ${last}`,
      `cliente${String(i).padStart(3, '0')}@example.test`,
      country,
      city,
      (Math.round(rand() * 400) * 25).toFixed(2),
      rand() > 0.12 ? 1 : 0,
      created.toISOString().slice(0, 19).replace('T', ' ')
    ])
  }
  await conn.query(
    'INSERT INTO shot_customers (name, email, country, city, credit_limit, active, created_at) VALUES ?',
    [customers]
  )

  const orders = []
  for (let i = 1; i <= 1500; i++) {
    const items = 1 + Math.floor(rand() * 6)
    const created = new Date(Date.UTC(2025, 0, 1) + Math.floor(rand() * 640 * 24) * 3600000)
    orders.push([
      1 + Math.floor(rand() * 200),
      pick(STATUSES),
      items,
      (items * (8 + rand() * 120)).toFixed(2),
      rand() > 0.85 ? 'Entrega en horario de mañana' : null,
      created.toISOString().slice(0, 19).replace('T', ' ')
    ])
  }
  await conn.query(
    'INSERT INTO shot_orders (customer_id, status, items, total, notes, created_at) VALUES ?',
    [orders]
  )

  await conn.query(`
    CREATE VIEW shot_customer_totals AS
      SELECT c.id, c.name, c.country, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS total
      FROM shot_customers c LEFT JOIN shot_orders o ON o.customer_id = c.id
      GROUP BY c.id, c.name, c.country
  `)
  // Grid editors: DATETIME(3), DATE, TIME, YEAR and a wide JSON column ("Texto" value panel).
  await conn.query(`
    DROP TABLE IF EXISTS shot_events;
    CREATE TABLE shot_events (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(80) NOT NULL,
      dateEnd DATETIME(3) NOT NULL,
      day DATE NULL,
      at_time TIME NULL,
      season YEAR NULL,
      payload JSON NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Eventos de demostración';
  `)
  const events = []
  for (let i = 1; i <= 40; i++) {
    const d = new Date(Date.UTC(2026, 8, 1) + i * 9 * 3600000)
    const iso = d.toISOString().replace('T', ' ').slice(0, 23)
    events.push([
      `Evento ${i}`,
      iso,
      iso.slice(0, 10),
      iso.slice(11, 19),
      2020 + (i % 7),
      JSON.stringify({
        cliente: { id: i, nombre: `Cliente ${i}`, vip: i % 3 === 0 },
        etiquetas: ['demo', i % 2 ? 'impar' : 'par'],
        importe: Math.round(i * 137.5) / 10,
        notas: null
      })
    ])
  }
  await conn.query(
    'INSERT INTO shot_events (title, dateEnd, day, at_time, season, payload) VALUES ?',
    [events]
  )

  // Local copy of rb_shop that the rollback screens replace (rb_crm does not exist locally).
  await conn.query(`
    DROP DATABASE IF EXISTS rb_shop;
    DROP DATABASE IF EXISTS rb_crm;
    CREATE DATABASE rb_shop;
    CREATE TABLE rb_shop.customers (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL);
    INSERT INTO rb_shop.customers VALUES (1, 'antiguo local 1'), (2, 'antiguo local 2');
    CREATE TABLE rb_shop.scratch (id INT PRIMARY KEY);
  `)
} finally {
  await conn.end()
}

/* ---------- MySQL 5.7 "staging" (rollback screens) ---------- */

const DIGITS =
  '(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)'
const SEQ = (digits) =>
  `(SELECT ${Array.from({ length: digits }, (_, i) => `t${i}.d * ${10 ** i}`).join(' + ')} + 1 AS n FROM ${Array.from({ length: digits }, (_, i) => `${DIGITS} t${i}`).join(' CROSS JOIN ')}) seq`

const conn57 = await mysql.createConnection({
  host: DB57.host,
  port: DB57.port,
  user: DB57.user,
  password: DB57.password,
  multipleStatements: true
})
try {
  await conn57.query(`
    DROP DATABASE IF EXISTS rb_shop;
    DROP DATABASE IF EXISTS rb_crm;
    CREATE DATABASE rb_shop CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE TABLE rb_shop.customers (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      city VARCHAR(60) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    INSERT INTO rb_shop.customers (name, city)
      SELECT CONCAT('Cliente ', n), ELT(1 + n % 4, 'Madrid', 'Sevilla', 'Lima', 'Quito') FROM ${SEQ(3)} WHERE n <= 800;
    CREATE TABLE rb_shop.events (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      customer_id INT NOT NULL,
      kind VARCHAR(12) NOT NULL,
      payload VARCHAR(160) NOT NULL,
      created_at DATETIME NOT NULL,
      KEY idx_customer (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    INSERT INTO rb_shop.events (customer_id, kind, payload, created_at)
      SELECT 1 + n % 800, ELT(1 + n % 4, 'login', 'logout', 'view', 'click'), REPEAT(MD5(n), 4),
             '2026-01-01 00:00:00' + INTERVAL n SECOND
      FROM ${SEQ(6)} WHERE n <= 250000;
    CREATE VIEW rb_shop.v_logins AS SELECT id, customer_id, created_at FROM rb_shop.events WHERE kind = 'login';
    CREATE TRIGGER rb_shop.customers_bi BEFORE INSERT ON rb_shop.customers FOR EACH ROW SET NEW.name = TRIM(NEW.name);
    CREATE DATABASE rb_crm CHARACTER SET utf8mb4;
    CREATE TABLE rb_crm.contacts (id INT PRIMARY KEY, email VARCHAR(120) NOT NULL, notes TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    INSERT INTO rb_crm.contacts SELECT n, CONCAT('contacto', n, '@example.test'), IF(n % 3 = 0, NULL, 'Llamar') FROM ${SEQ(3)} WHERE n <= 300;
    CREATE FUNCTION rb_crm.f_domain(email VARCHAR(120)) RETURNS VARCHAR(120) DETERMINISTIC NO SQL RETURN SUBSTRING_INDEX(email, '@', -1);
    -- Accepted by 5.7 (binlog off) but refused by an 8.4 with binlog on: shows a partly restored database.
    CREATE FUNCTION rb_crm.f_score(n INT) RETURNS INT RETURN n * 2;
  `)
} finally {
  await conn57.end()
}

console.log(`Seeded profile ${PROFILE}`)
console.log(
  `Seeded ${DB.database} on ${DB.host}:${DB.port} (shot_customers 200, shot_orders 1500, shot_customer_totals)`
)
console.log(
  `Seeded rb_shop/rb_crm on ${DB57.host}:${DB57.port} (5.7 staging) and an older rb_shop locally`
)
