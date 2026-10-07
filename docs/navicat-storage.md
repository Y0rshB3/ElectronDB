# Navicat for MySQL (macOS, "Navicat CC" generation) — verified storage layout

Everything below was verified on 2026-09-14 against a real installation. Paths are
relative to `~/Library/Application Support/PremiumSoft CyberTech/Navicat CC/`.

## Files

| Path                                              | Format     | Content                                                                                                                                   |
| ------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Common/conn.plist`                               | XML plist  | Connections: `{"0": {"0": {"MySQL": {"<name>": {...}}}}}`                                                                                 |
| `Common/pref.plist`                               | XML plist  | UI prefs. Connection colour at `connpref/0/0/MySQL/<name>/""/""/serverpref/markercolor` (two empty-string keys before `serverpref` on real installs; the importer accepts both)                                                         |
| `Common/Settings/0/0/MySQL/<conn>/`               | dir        | Per-connection savepath. Contains `id_cache.db` (SQLite identifier cache) and one folder per schema                                       |
| `Common/Settings/0/0/MySQL/<conn>/<schema>/*.nb3` | tar        | Backups. File name = `YYYYMMDDHHmmss[ -label                                                                                              | label].nb3` |
| `Navicat for MySQL/Profiles/*.nbatmysql`          | JSON       | Batch jobs ("Automatización")                                                                                                             |
| `Navicat for MySQL/schedule.plist`                | XML plist  | Schedules (an empty `<dict/>` on the installation inspected)                                                                             |
| `Navicat for MySQL/Logs/QueryExec.log`            | text       | Query log                                                                                                                                 |

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
