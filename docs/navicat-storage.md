# Navicat for MySQL (macOS, "Navicat CC" generation) — verified storage layout

Everything below was verified on 2026-09-14 against a real installation. Paths are
relative to `~/Library/Application Support/PremiumSoft CyberTech/Navicat CC/`.

## Files

| Path                                              | Format    | Content                                                                                                                                                                         |
| ------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Common/conn.plist`                               | XML plist | Connections: `{"0": {"0": {"MySQL": {"<name>": {...}}}}}`                                                                                                                       |
| `Common/pref.plist`                               | XML plist | UI prefs. Connection colour at `connpref/0/0/MySQL/<name>/""/""/serverpref/markercolor` (two empty-string keys before `serverpref` on real installs; the importer accepts both) |
| `Common/Settings/0/0/MySQL/<conn>/`               | dir       | Per-connection savepath. Contains `id_cache.db` (SQLite identifier cache) and one folder per schema                                                                             |
| `Common/Settings/0/0/MySQL/<conn>/<schema>/*.nb3` | tar       | Backups. File name = `YYYYMMDDHHmmss[ -label                                                                                                                                    | label].nb3` |
| `Navicat for MySQL/Profiles/*.nbatmysql`          | JSON      | Batch jobs ("Automatización")                                                                                                                                                   |
| `Navicat for MySQL/schedule.plist`                | XML plist | Schedules (an empty `<dict/>` on the installation inspected)                                                                                                                    |
| `Navicat for MySQL/Logs/QueryExec.log`            | text      | Query log                                                                                                                                                                       |

## conn.plist connection keys (subset that matters)

```
host (string)             port (string!)         username (string)
savepassword (bool)       autoconnect (int)      encoding (int)   clientencoding (int, 65001)
usecustomdblist (bool)    customdblist (array of string)
initialsessionqueries (string)
usetunnel (bool)          ssh_param { host, port (int), username, authtype (int: 0=password, 1=key), pkeyfile, savepassword }
usessl (bool)             ssl_param { cacert, clientcert, clientkeyfile, verifyca, ... }
usehttptunnel (bool)      http_param { url, useauth, username }
savepath (string)         remarks (string)       starred (bool)   hidden (bool)
ServerVersion (int, e.g. 80036)   ServerVersionStr (string)
created_time / modified_time / access_time (unix seconds)
compatibility_param { sql_mode, lower_case_table_names, ... }
```

No `password` key exists: connection passwords are not stored in any of these files, so an
import always asks the user to type them (Vortaq reads nothing else of Navicat's, such as the
system keychain). There is `pemclientkeypassword` inside `ssl_param` (empty).

### Other sections (unverified)

Only the `MySQL` section above was verified on the author's files. The folder import also reads
the `MariaDB` (same keys as MySQL), `PostgreSQL`, `SQLite` and `MongoDB` sections with the key
names of the design (docs/multi-engine-design.md, 12.1). **None of these is confirmed by a real
file**; they are tested with the synthetic `MULTI_TYPE_CONN_PLIST` (`src/main/navicat/testing.ts`)
and every key is optional:

- `PostgreSQL`: `initialdatabase`, `hostportlist` (first host only, with a warning),
  `ssl_param.mode` (any libpq spelling) and `ssl_param.rootcert`, `usecustomdblist` as an integer,
  `serviceprovider` (forks such as Redshift stay unsupported).
- `SQLite`: `databasefile` (also `databasefilename`), the path on the machine that wrote it. Only
  the text is checked: a path that is not absolute on this OS (a `C:\…` path on a Mac adds «Ruta de
  otro equipo: revísala») or whose file is missing here is imported flagged for review, and the
  connection cannot open until the user picks the file; the file is never opened or created by the
  import. `sqliteencrypted` makes the row not importable. `attacheddatabases` (shape unknown) is
  not imported, with a warning.
- `MongoDB`: `host`, `port`, `username`, `database`, `connmethod` (`Standalone`, `Replica Set` /
  `ReplicaSet`, `ShardCluster`, `SRV`), `usesrvrecord`, `memberlist` (an array of `host:port`
  strings or of `{host, port}` dicts; any other shape adds a warning), `replicasetname`,
  `authsource`, `authmechanism` (`GSSAPI`/Kerberos, AWS and OIDC make the row not importable),
  `readpreference`, `retrywrites`/`retryreads`, `serviceprovider` (`DocumentDB` and
  `AzureCosmosDB` turn retryable writes off with a warning; `MongoDBAtlas` and SRV turn TLS on),
  `usessl`/`ssl_param` and the SSH keys as for MySQL. Timeouts are not read.

## Colour blob (`markercolor`)

NSArchiver "streamtyped" NSColor. After the ASCII marker `ffff` come four
components (r, g, b, a) encoded each as either:

- `0x83` followed by a little-endian float32, or
- a single byte `0x00`/`0x01` meaning 0.0 / 1.0.

Observed values: green = (0.41, 0.94, 0.68), red = (1, 0.32, 0.32),
yellow = (1, 0.76, 0.03).

## Batch job (`*.nbatmysql`)

```json
{
  "Version": 1.3,
  "General": {
    "SendEmail": false,
    "SendEmailWhenSuccess": true,
    "SendEmailWhenFail": true,
    "EmailFrom": "",
    "EmailTo": "",
    "EmailCC": "",
    "EmailSubject": "",
    "EmailBody": "%L",
    "EmailServerHost": "",
    "EmailServerPort": "",
    "EmailServerUserName": "",
    "EmailServerPassword": "",
    "UseAuthentication": false,
    "SecureMethod": "",
    "ContinueOnError": true
  },
  "Jobs": [
    {
      "TypeName": "backupschema",
      "CloudInstanceID": "",
      "ProjectOwnerNavicatID": "",
      "Project": "",
      "ServerType": "MYSQL",
      "Server": "<connection name>",
      "Catalog": "",
      "Schema": "<schema>",
      "DatabaseBrandName": "MySQL",
      "ReferenceName": "Backup <schema>",
      "Param1": "",
      "Param2": "",
      "ExtraParams": {},
      "UseAttachment": false
    }
  ]
}
```

The job name is the file name without extension.

## Backup file (`.nb3`)

POSIX ustar tar, entries mode 0644, uid/gid 0, mtime 0, **`meta.json` is the last entry**.

```
<UUID>.data.00000.sql.gz   rows of one table, chunk N (≈5 MB uncompressed per chunk, split on row boundary)
<UUID>.data.00001.sql.gz   ...
<UUID>.meta.json.gz        per-object metadata (see below)
meta.json                  backup manifest (plain JSON, indented)
```

`meta.json`:

```json
{
  "MetaVersion": "30101",
  "DatabaseType": "MYSQL",
  "ServiceProvider": "",
  "Catalog": "",
  "Schema": "billing",
  "StartTime": "1773776881",
  "EndTime": "1773776886",
  "Encryption": "None",
  "Comment": "",
  "Objects": [
    {
      "UUID": "...",
      "Type": "Table",
      "Name": "account",
      "Rows": "3",
      "Metadata": {
        "Filename": "<UUID>.meta.json.gz",
        "Checksum": "<SHA1 hex upper of the gz bytes>"
      }
    }
  ]
}
```

`<UUID>.meta.json.gz` (gzip of JSON):

```json
{ "MetaVersion": "30101", "Name": "account", "Type": "Table",
  "DDL": "CREATE TABLE `account`  (...) ENGINE = InnoDB ...",
  "SubDDL": [], "AutoIncrement": "", "Fields": ["id", "name", ...],
  "TriggerDDL": [], "IndexDDL": [],
  "Data": [ { "Filename": "<UUID>.data.00000.sql.gz", "Checksum": "<SHA1 of gz bytes>" } ] }
```

Data chunk (after gunzip): one MySQL value tuple per row, **rows separated by
`0x1E 0x0A`** (record separator + newline), no trailing separator, no `INSERT`
keyword. Example: `(1, 'Ana', NULL, '2026-01-02 03:04:05')\x1e\n(2, 'Bob', ...)`.
Literal escaping is MySQL style (`\'`, `\"`, `\\`, `\n`). Tables with zero rows
have an empty `Data` array and no data entry. Restore = `INSERT INTO t (Fields...) VALUES <tuple>, ...`.

Observed object `Type` values so far: only `Table`. Other types are expected to
carry their DDL in the same `DDL` field.

## Connection export file (`.ncx`)

Written by Navicat's own **File › Export Connections** (optionally with **Export
Password**); the user picks it in «Importar… › Navicat — archivo .ncx». Notes from
the publicly known structure of the format; parser: `src/main/importers/connections/ncx.ts`,
tests on synthetic files in `tests/fixtures/importers/ncx/`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="…" ConnType="MYSQL" Host="…" Port="3306" UserName="…" Password="<hex>" … />
</Connections>
```

- Only direct `<Connection>` children of `<Connections>` are read. A UTF-8 BOM is tolerated.
- `Ver` 1.1 and 1.4 write every attribute on every connection; **1.5 omits default/off
  attributes**, so every attribute is optional (MySQL port 3306, SSH port 22, flags off).
- `ConnType` (case-insensitive): `MYSQL`, `MARIADB`, `POSTGRESQL`, `SQLITE`, `MONGODB`,
  `SQLSERVER`, `ORACLE`, `REDIS`, `SNOWFLAKE`. The first five are importable; the rest are listed
  with «Motor no soportado en esta versión». The import identity is
  `(type, ConnectionName)`, the same as for `conn.plist` imports, so an `.ncx` merges into
  connections imported from the folder.
- Attributes used: `ConnectionName`, `ConnType`, `Host`, `Port`, `UserName`, `Database`,
  `SSH`, `SSH_Host`, `SSH_Port`, `SSH_UserName`, `SSH_AuthenMethod` (`PASSWORD` |
  `PUBLICKEY`), `SSH_PrivateKey`, `SSL`, `SSL_CACert`, `SSL_ClientCert`, `SSL_ClientKey`,
  `SSL_Authen`, `HTTP` («Túnel HTTP no soportado»).
- PostgreSQL: `InitialDatabase` (falls back to `Database`, then `postgres`), port default
  5432, `ServiceProvider` (`Redshift`, `GaussDB`/`openGauss`, `KingbaseES` stay unsupported
  with a reason), `Host` lists such as `h1:5432,h2:5433` (only the first host is used, with a
  warning).
- SQLite: `DatabaseFileName` (the file path on the machine that exported it; attribute name
  from public parsers, not from a sample of the user's). `Host`, `Port` and `UserName` are
  empty. The path is kept as written and flagged for review (the connection cannot open until
  the user picks the file) when it is not absolute on this OS or the file does not exist
  here; the file is never opened or created by the import. `SQLiteEncrypt="true"` (Ver 1.4+)
  or `SQLiteEncryption="true"` (Ver 1.1; only the `true` value is assumed) marks Navicat's
  encrypted files: listed as not importable, and `SQLiteEncryptPassword` is never read.
  Imported SQLite connections keep foreign keys off and use no password. No attached
  databases are imported (no documented attribute).
- MongoDB (`MONGODB`): attribute names from public
  parsers and the design notes, **not confirmed by a sample** of the user's, read case-insensitively and never
  required. `ConnMethod` (also `ConnectionMethod`): `Standalone`, `ReplicaSet` / `Replica Set`,
  `ShardCluster`, `SRV`; `UseSRVRecord` (SRV: port unused, TLS on); `ReplicaSetName`; `AuthSource`;
  `AuthMechanism` (`SCRAM-SHA-1`, `SCRAM-SHA-256`, `X509`, `PLAIN`/`LDAP`, `None`; `GSSAPI`/Kerberos, AWS and
  OIDC make the row not importable); `ReadPreference`; `RetryWrites` / `RetryReads`; `ServiceProvider`
  (`DocumentDB` and `AzureCosmosDB` turn retryable writes off with a warning; `MongoDBAtlas` turns TLS on).
  A replica set's `Host="localhost"` is a placeholder: the seeds come from `<Member Host Port>` children and
  the database from `<Advance Database>` (else `Database`). Passwords use the same slots as MySQL.
- **Unverified** (accepted when present, never required): `SSL_VerifyCA`, a colour attribute
  (`Color` / `ConnectionColor`), and the PostgreSQL SSL mode attribute (`SSL_Mode` /
  `SSLMode`, any libpq spelling); no sample confirms how Navicat writes them.
- Secrets: `Password`, `SSH_Password`, `SSH_Passphrase`, `SSL_PEMClientKeyPassword`, hex of
  a fixed-key scheme (AES-128-CBC in current versions, Blowfish in older ones;
  `src/main/importers/navicat/ncxCipher.ts`). `Ver` < 1.4 tries Blowfish first, newer files
  AES first. Decoded values go only to `CredentialStore` (`mysql`; `ssh` takes
  `SSH_Passphrase` with `PUBLICKEY`, else `SSH_Password`; `sslKey`). They are never logged
  or sent to the renderer. The wizard reminds the user to delete the file afterwards.
- Key/certificate paths written on another OS (`C:\…` on macOS/Linux, `/…` on Windows) are
  kept with the warning «Ruta de otro equipo: revísala». `SettingsSavePath` is ignored.
