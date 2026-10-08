/* global process, console, Buffer */
/**
 * Seeds a scratch profile with SQLite files for the SQLite screenshots (steps 42*
 * of src/main/screenshots.ts). No server needed: the databases are files in the
 * scratch folder, written with Node's built-in node:sqlite.
 *
 *   node scripts/seed-sqlite-shots.mjs
 *   npm run build
 *   VORTAQ_USER_DATA=$TMPDIR/vortaq-sqlite-shots/profile VORTAQ_PLAIN_SECRETS=1 \
 *   VORTAQ_SCREENSHOTS=$TMPDIR/vortaq-sqlite-shots VORTAQ_SHOTS_ONLY=42 npx electron .
 *
 * Env: VORTAQ_SHOTS_SQLITE_PROFILE (scratch profile, wiped; must end in /profile).
 * Never touches the real profile. Data is synthetic.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const env = (name) => process.env[`VORTAQ_${name}`] ?? process.env[`ELECTRONDB_${name}`]
const PROFILE = resolve(
  env('SHOTS_SQLITE_PROFILE') ||
    join(process.env.TMPDIR || '/tmp', 'vortaq-sqlite-shots', 'profile')
)
if (basename(PROFILE) !== 'profile') {
  console.error(
    `Refusing to wipe ${PROFILE}: the scratch profile directory must be named "profile".`
  )
  process.exit(1)
}
const FILES = join(dirname(PROFILE), 'files')
rmSync(PROFILE, { recursive: true, force: true })
rmSync(FILES, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
mkdirSync(FILES, { recursive: true })

function create(path, sql) {
  const url = pathToFileURL(path)
  url.searchParams.set('mode', 'rwc')
  const db = new DatabaseSync(url)
  db.exec(sql)
  db.close()
}

const TIENDA = join(FILES, 'tienda.db')
create(
  TIENDA,
  `
  PRAGMA foreign_keys = ON;
  CREATE TABLE clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL COLLATE NOCASE,
    email TEXT UNIQUE,
    alta TEXT NOT NULL DEFAULT (datetime('now')),
    notas
  );
  CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL REFERENCES clientes (id),
    estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado', 'cancelado')),
    total NUMERIC NOT NULL DEFAULT 0 CHECK (total >= 0),
    creado TEXT NOT NULL DEFAULT (date('now'))
  );
  CREATE TABLE etiquetas (clave TEXT, valor TEXT, PRIMARY KEY (clave, valor)) WITHOUT ROWID;
  CREATE INDEX pedidos_cliente_idx ON pedidos (cliente_id);
  CREATE INDEX pedidos_estado_idx ON pedidos (estado) WHERE estado <> 'cancelado';
  CREATE VIEW pedidos_pendientes AS
    SELECT p.id, c.nombre, p.total, p.creado
      FROM pedidos p JOIN clientes c ON c.id = p.cliente_id
     WHERE p.estado = 'pendiente';
  CREATE TRIGGER pedidos_sin_total BEFORE INSERT ON pedidos
  WHEN NEW.total < 0
  BEGIN
    SELECT RAISE(ABORT, 'El total no puede ser negativo');
  END;
  INSERT INTO clientes (nombre, email, alta, notas) VALUES
    ('Ana Torres', 'ana@example.test', '2026-09-01 10:15:00', 'VIP'),
    ('Bruno Díaz', 'bruno@example.test', '2026-09-03 08:40:00', 42),
    ('Carla Pérez', NULL, '2026-09-10 17:05:00', x'CAFE'),
    ('David Ruiz', 'david@example.test', '2026-09-12 12:00:00', NULL);
  INSERT INTO pedidos (cliente_id, estado, total, creado) VALUES
    (1, 'pagado', 120.50, '2026-09-02'),
    (1, 'pendiente', 35.00, '2026-09-15'),
    (2, 'pendiente', 18.90, '2026-09-16'),
    (3, 'cancelado', 0, '2026-09-18'),
    (4, 'pendiente', 64.25, '2026-09-20');
  INSERT INTO etiquetas VALUES ('canal', 'web'), ('canal', 'tienda'), ('zona', 'norte');
`
)

const ARCHIVO = join(FILES, 'archivo-2025.db')
create(
  ARCHIVO,
  `
  CREATE TABLE pedidos_2025 (id INTEGER PRIMARY KEY, cliente TEXT, total REAL, creado TEXT);
  INSERT INTO pedidos_2025 VALUES (1, 'Ana Torres', 99.0, '2025-03-01'), (2, 'Bruno Díaz', 12.5, '2025-07-21');
`
)

// An empty file the job below restores into (created like «Crear base de datos nueva…»).
const COPIA = join(FILES, 'tienda-copia.db')
create(COPIA, 'CREATE TABLE vieja (x)')

const iso = new Date().toISOString()
const base = {
  color: null,
  host: '',
  port: 0,
  username: '',
  authMode: 'none',
  savePassword: false,
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
  updatedAt: iso,
  engine: 'sqlite'
}
const connections = [
  {
    ...base,
    id: 'shot-lite',
    name: 'Tienda (SQLite)',
    color: '#34d399',
    environment: 'local',
    initialQueries: 'PRAGMA cache_size = -8000',
    sqlite: {
      filePath: TIENDA,
      readOnly: false,
      foreignKeys: true,
      attached: [{ alias: 'archivo', filePath: ARCHIVO }],
      busyTimeoutMs: 5000
    }
  },
  {
    ...base,
    id: 'shot-lite-import',
    name: 'Inventario (importada)',
    environment: 'staging',
    sqlite: {
      filePath: 'C:\\Users\\ana\\Documents\\inventario.db',
      pathNeedsReview: true,
      readOnly: false,
      foreignKeys: false,
      attached: [],
      busyTimeoutMs: 5000
    },
    source: { app: 'dbeaver', name: 'Inventario', importedAt: iso, format: 'json' }
  },
  {
    ...base,
    id: 'shot-lite-copy',
    name: 'Tienda copia (SQLite)',
    color: '#60a5fa',
    environment: 'local',
    sqlite: {
      filePath: COPIA,
      readOnly: false,
      foreignKeys: true,
      attached: [],
      busyTimeoutMs: 5000
    }
  }
]
const jobs = [
  {
    id: 'shot-job-lite',
    name: 'Tienda SQLite a copia local',
    continueOnError: false,
    tasks: [
      {
        id: 'b1',
        type: 'backupschema',
        connectionId: 'shot-lite',
        schema: 'main',
        referenceName: 'Backup tienda',
        includeData: true,
        format: 'vqb',
        encrypt: true
      },
      {
        id: 'r1',
        type: 'restoreschema',
        connectionId: 'shot-lite-copy',
        schema: 'main',
        referenceName: 'Restaurar en la copia',
        restoreSource: { kind: 'task', taskId: 'b1' },
        safetyBackup: true,
        includeData: true
      }
    ],
    schedule: { enabled: true, cron: '30 2 * * *', launchAgent: false },
    createdAt: iso,
    updatedAt: iso,
    lastRunAt: null
  }
]

const write = (name, data) =>
  writeFileSync(join(PROFILE, name), JSON.stringify(data, null, 2), { mode: 0o600 })
write('connections.json', { version: 1, items: connections })
write('jobs.json', { version: 1, items: jobs })
// The job's backup password (synthetic), so the editor shows «contraseña guardada».
write('credentials.json', {
  version: 1,
  codec: 'plain',
  items: { 'backupKey:shot-job-lite': Buffer.from('clave de ejemplo 2026', 'utf8').toString('base64') }
})
write('settings.json', { theme: 'dark', checkUpdatesOnStartup: false })
console.log(`Seeded ${PROFILE} (SQLite files in ${FILES})`)
