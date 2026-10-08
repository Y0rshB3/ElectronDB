/* global process, console, Buffer, URL */
/**
 * Seeds a scratch profile and the throwaway MongoDB test server for the MongoDB
 * screenshots (steps 43* of src/main/screenshots.ts).
 *
 *   node scripts/seed-mongo-shots.mjs
 *   npm run build
 *   VORTAQ_USER_DATA=$TMPDIR/vortaq-mongo-shots/profile VORTAQ_PLAIN_SECRETS=1 \
 *   VORTAQ_SCREENSHOTS=$TMPDIR/vortaq-mongo-shots VORTAQ_SHOTS_ONLY=43 npx electron .
 *
 * Env: VORTAQ_TEST_MONGO_URL (default mongodb://root:navidog@127.0.0.1:57017/?authSource=admin),
 * VORTAQ_SHOTS_MONGO_PROFILE (scratch profile, wiped; must end in /profile). Creates the
 * database `tienda_shots` on the test server (dropped first). Data is synthetic.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Decimal128, Double, Int32, Long, MongoClient, ObjectId, UUID } from 'mongodb'

const env = (name) => process.env[`VORTAQ_${name}`] ?? process.env[`ELECTRONDB_${name}`]
const URL_TEXT = env('TEST_MONGO_URL') || 'mongodb://root:navidog@127.0.0.1:57017/?authSource=admin'
const PROFILE = resolve(
  env('SHOTS_MONGO_PROFILE') || join(process.env.TMPDIR || '/tmp', 'vortaq-mongo-shots', 'profile')
)
if (basename(PROFILE) !== 'profile') {
  console.error(
    `Refusing to wipe ${PROFILE}: the scratch profile directory must be named "profile".`
  )
  process.exit(1)
}
const DB = 'tienda_shots'

const client = new MongoClient(URL_TEXT, { serverSelectionTimeoutMS: 5000 })
await client.connect()
const db = client.db(DB)
await db.dropDatabase()
await db.createCollection('clientes', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['nombre', 'email'],
      properties: {
        nombre: { bsonType: 'string' },
        email: { bsonType: 'string' },
        puntos: { bsonType: ['int', 'long', 'double'] }
      }
    }
  }
})
const ids = Array.from({ length: 6 }, (_, i) => new ObjectId(`6a00000000000000000000${10 + i}`))
await db.collection('clientes').insertMany([
  {
    _id: ids[0],
    nombre: 'Ana Torres',
    email: 'ana@example.test',
    puntos: new Int32(120),
    saldo: Decimal128.fromString('150.75'),
    alta: new Date('2026-09-01T10:15:00Z'),
    etiquetas: ['vip', 'web'],
    direccion: { ciudad: 'Lima', cp: new Int32(15001) }
  },
  {
    _id: ids[1],
    nombre: 'Bruno Díaz',
    email: 'bruno@example.test',
    puntos: Long.fromString('9007199254740993'),
    saldo: Decimal128.fromString('0.00'),
    alta: new Date('2026-09-03T08:40:00Z'),
    etiquetas: ['tienda'],
    direccion: { ciudad: 'Cusco', cp: new Int32(8000) }
  },
  {
    _id: ids[2],
    nombre: 'Carla Pérez',
    email: 'carla@example.test',
    puntos: new Int32(42),
    saldo: Decimal128.fromString('12.10'),
    alta: new Date('2026-09-10T17:05:00Z'),
    etiquetas: [],
    token: new UUID('0e3b4a3c-7b5f-4b1a-9a7e-1d2e3f4a5b6c')
  },
  {
    _id: ids[3],
    nombre: 'David Ruiz',
    email: 'david@example.test',
    puntos: new Double(7),
    alta: new Date('2026-09-12T12:00:00Z'),
    activo: false
  }
])
await db.collection('clientes').createIndex({ email: 1 }, { unique: true, name: 'email_unico' })
await db
  .collection('clientes')
  .createIndex({ 'direccion.ciudad': 1, alta: -1 }, { name: 'ciudad_alta' })
await db.collection('pedidos').insertMany(
  Array.from({ length: 24 }, (_, i) => ({
    cliente: ids[i % 4],
    estado: ['pendiente', 'pagado', 'enviado'][i % 3],
    total: Decimal128.fromString(`${(20 + i * 7.35).toFixed(2)}`),
    lineas: new Int32(1 + (i % 4)),
    creado: new Date(Date.UTC(2026, 8, 1 + i, 9, 30))
  }))
)
await db.collection('pedidos').createIndex({ estado: 1, creado: -1 })
await db
  .collection('pedidos')
  .createIndex({ creado: 1 }, { expireAfterSeconds: 31536000, name: 'caduca' })
await db.createCollection('eventos', { capped: true, size: 65536 })
await db.collection('eventos').insertOne({ tipo: 'arranque', en: new Date('2026-10-01T00:00:00Z') })
await db.createCollection('pedidos_pendientes', {
  viewOn: 'pedidos',
  pipeline: [{ $match: { estado: 'pendiente' } }, { $project: { cliente: 1, total: 1, creado: 1 } }]
})
await client.close()

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
const u = new URL(URL_TEXT)
const iso = new Date().toISOString()
const connection = {
  id: 'shot-mongo',
  name: 'Tienda (MongoDB)',
  color: '#4ade80',
  environment: 'local',
  host: u.hostname,
  port: Number(u.port || 27017),
  username: decodeURIComponent(u.username),
  authMode: 'password',
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
  ssl: { enabled: false, verifyServer: true },
  backupDir: join(dirname(PROFILE), 'backups'),
  extraBackupDirs: [],
  createdAt: iso,
  updatedAt: iso,
  engine: 'mongodb',
  network: { connectTimeoutMs: 5000, keepAliveSec: 60 },
  mongo: {
    topology: 'standalone',
    srv: false,
    members: [],
    replicaSet: '',
    authMechanism: 'default',
    authSource: u.searchParams.get('authSource') || 'admin',
    defaultDatabase: DB,
    readPreference: 'primary',
    directConnection: false,
    retryWrites: true,
    retryReads: true,
    extraOptions: {}
  }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const write = (name, data) =>
  writeFileSync(join(PROFILE, name), JSON.stringify(data, null, 2), { mode: 0o600 })
write('connections.json', { version: 1, items: [connection] })
write('credentials.json', {
  version: 1,
  codec: 'plain',
  items: { 'mysql:shot-mongo': b64(decodeURIComponent(u.password)) }
})
write('settings.json', { theme: 'dark', checkUpdatesOnStartup: false })
console.log(`Seeded ${PROFILE} (database ${DB} on ${u.hostname}:${u.port})`)
