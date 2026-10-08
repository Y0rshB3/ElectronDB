# The .vqb backup format (Vortaq Backup), version 1

`.vqb` is the backup format Vortaq writes by default. This document is its public
specification: with it, anyone can read a `.vqb` file without Vortaq, using a ZIP tool, gzip
and a JSON parser (plus AES-GCM and scrypt for encrypted files). The examples in this
document are parsed by the test suite (`src/main/backup/vqb/spec.test.ts`), so they stay
valid.

- File extension: `.vqb`. Suggested media type: `application/vnd.vortaq.backup+zip`.
- Engines in version 1: MySQL and MariaDB (`"engine": {"id": "mysql"}`), PostgreSQL
  (`"engine": {"id": "postgresql"}`), SQLite (`"sqlite"`) and MongoDB (`"mongodb"`).
- One file holds one MySQL schema, one PostgreSQL database (all of its non-system schemas), one SQLite
  database or one MongoDB database (all of its collections and views, or the ones selected).
- Restores go to the same engine only.

## 1. Container

A `.vqb` file is a standard ZIP archive (APPNOTE 6.3):

- Every entry is **stored** (method 0, no deflate): data files are already gzip, and
  encrypted entries do not compress. Readers must refuse other methods.
- Entry names are UTF-8 (general purpose bit 11) and use `/` as separator.
- Local headers carry the CRC-32 and sizes (no data descriptors).
- ZIP64 records (zip64 end of central directory record and locator, and the zip64 extra
  field for the local header offset) appear when the archive passes 4 GiB or 65,535
  entries. A single entry is never larger than 1 GiB (data is split, section 4).

**Why ZIP and not tar.** Both can be written as a stream. ZIP also ends with a central
directory, so a reader lists every entry and finds `manifest.json`, which is written last,
with two small reads at the end of the file, however large the backup is. A tar file has to
be walked header by header to find its last entry. ZIP is also opened by every operating
system without extra tools. Vortaq writes and reads the container with its own small
implementation (`src/main/backup/vqb/zip.ts`), with no third-party dependency.

## 2. Entries

```
header.json                         first entry, never encrypted
objects/000001/data-000001.jsonl.gz rows of a table, in ~5 MB pieces (tables only)
objects/000001/data-000002.jsonl.gz
objects/000001/ddl.sql              the object's main statement
objects/000001/meta.json            columns, counters, indexes, triggers…
objects/000002/ddl.sql
objects/000002/meta.json
…
manifest.json                       last entry
```

Objects are numbered in backup order (`000001`, `000002`…), which is also a valid restore
order for each engine (section 6). Folder names never contain object names, so an encrypted
backup does not reveal them. Readers must not rely on the order of entries in the ZIP: use
the manifest.

## 3. header.json

Always plaintext. It says how to read everything else.

Unencrypted:

```json vqb-header
{
  "format": "vortaq-backup",
  "formatVersion": 1,
  "encrypted": false
}
```

Encrypted (section 7):

```json vqb-header
{
  "format": "vortaq-backup",
  "formatVersion": 1,
  "encrypted": true,
  "encryption": {
    "alg": "AES-256-GCM",
    "chunkSize": 65536,
    "kdf": {
      "name": "scrypt",
      "N": 131072,
      "r": 8,
      "p": 1,
      "salt": "yS1h2vhpTP0bHCUdFkHn0g==",
      "keyLength": 64
    },
    "keyCheck": "q3d0a2qGg0q9q3o3cGJd3m1XyQ4YQnqL8bA0b5E1wkE="
  }
}
```

## 4. manifest.json

Written last, after every object. When the backup is encrypted, `manifest.json` is encrypted
too (object names, the database name and the connection name are not visible without the
password).

```json vqb-manifest
{
  "format": "vortaq-backup",
  "formatVersion": 1,
  "app": { "name": "Vortaq", "version": "0.2.0" },
  "engine": { "id": "mysql", "flavor": "mysql", "serverVersion": "8.4.3" },
  "source": {
    "connectionName": "Staging",
    "database": "shop",
    "charset": "utf8mb4",
    "collation": "utf8mb4_0900_ai_ci",
    "timeZone": "+00:00"
  },
  "createdAt": "2026-10-07T08:00:00.000Z",
  "finishedAt": "2026-10-07T08:00:04.512Z",
  "comment": "Antes de la migración",
  "options": { "includeData": true, "structureOnly": false, "partial": false },
  "encryption": null,
  "objects": [
    {
      "id": "000001",
      "type": "table",
      "name": "customers",
      "rows": 2,
      "files": [
        {
          "path": "objects/000001/data-000001.jsonl.gz",
          "sha256": "4f2c0b8e6a4b5f0f1d9b8f3e1b4f8e1c2a7d9e0f1b2c3d4e5f60718293a4b5c6",
          "bytes": 213
        },
        {
          "path": "objects/000001/ddl.sql",
          "sha256": "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
          "bytes": 190
        },
        {
          "path": "objects/000001/meta.json",
          "sha256": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0",
          "bytes": 512
        }
      ]
    },
    {
      "id": "000002",
      "type": "view",
      "name": "v_customers",
      "rows": null,
      "files": [
        {
          "path": "objects/000002/ddl.sql",
          "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
          "bytes": 96
        },
        {
          "path": "objects/000002/meta.json",
          "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
          "bytes": 80
        }
      ]
    }
  ]
}
```

| Field                                | Meaning                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `formatVersion`            | Same as the header.                                                                                                                                                                                                    |
| `app`                                | Program that wrote the file.                                                                                                                                                                                           |
| `engine`                             | `id`: `mysql` (MySQL and MariaDB), `postgresql`, `sqlite` or `mongodb`. `flavor`: `mysql`, `mariadb`, `postgresql`, `sqlite` or `mongodb`. `serverVersion`: as the server reports it.                                  |
| `source.connectionName`              | Name of the connection in the app. Omitted when the user chooses not to record it.                                                                                                                                     |
| `source.database`                    | MySQL: the schema. PostgreSQL: the database. SQLite: the attached database alias (`main`). MongoDB: the database.                                                                                                      |
| `source.schemas`                     | PostgreSQL only: schemas included (every non-system schema).                                                                                                                                                           |
| `source.charset`, `source.collation` | MySQL only: the schema defaults, used when the schema is created again.                                                                                                                                                |
| `source.encoding`                    | PostgreSQL: `server_encoding` of the database. SQLite: `PRAGMA encoding`.                                                                                                                                              |
| `source.timeZone`                    | MySQL only: session `time_zone` the `TIMESTAMP` values were read in (`+00:00`). A restore must set the same session time zone before inserting them.                                                                   |
| `createdAt`, `finishedAt`            | ISO 8601, UTC.                                                                                                                                                                                                         |
| `comment`                            | Optional free text.                                                                                                                                                                                                    |
| `options`                            | `includeData` (false: structure only, data files absent), `structureOnly` (its negation, for readers that look for it), `partial` (only some objects were selected).                                                   |
| `encryption`                         | `null`, or `{"alg": "AES-256-GCM", "kdf": "scrypt"}` (parameters in the header).                                                                                                                                       |
| `objects[]`                          | `id` (folder number), `type`, `name`, `schema` (PostgreSQL), `rows` (tables: rows written; otherwise `null`), `files[]` with `path`, `sha256` (hex) and `bytes` of every entry of the object **as stored in the ZIP**. |
| `warnings`                           | Optional: what the backup could not include, in the user's language (MariaDB system-versioned tables, PostgreSQL aggregates…).                                                                                         |

Object `type`s: MySQL/MariaDB `table`, `view`, `function`, `procedure`, `event`; SQLite `table`, `view`;
MongoDB `collection`, `view`;
PostgreSQL `extension`, `type`, `sequence`, `table`, `function`, `procedure`, `view`,
`materialized_view`.

## 5. Object files

### ddl.sql

Exactly one statement in the source engine's dialect, without a trailing `;`: MySQL's
`SHOW CREATE …` output, or for PostgreSQL the statement rebuilt from the catalog with every
name schema-qualified. It may contain `;` inside routine bodies, so execute it as one
statement and never split it.

### meta.json

```json vqb-meta
{
  "name": "customers",
  "type": "table",
  "ddl": "objects/000001/ddl.sql",
  "columns": [
    { "name": "id", "type": "int unsigned" },
    { "name": "name", "type": "varchar(80)" },
    { "name": "price", "type": "decimal(30,10)" },
    { "name": "photo", "type": "mediumblob" },
    { "name": "created", "type": "datetime(6)" },
    { "name": "doc", "type": "json" }
  ],
  "rows": 2,
  "data": [{ "path": "objects/000001/data-000001.jsonl.gz", "rows": 2 }],
  "autoIncrement": "3",
  "triggers": [
    "CREATE DEFINER=`app`@`%` TRIGGER `customers_bi` BEFORE INSERT ON `customers` FOR EACH ROW SET NEW.name = TRIM(NEW.name)"
  ],
  "indexes": [],
  "foreignKeys": []
}
```

| Field                    | Meaning                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `type`, `schema` | As in the manifest.                                                                                                                                                                                                                 |
| `ddl`                    | Path of `ddl.sql`.                                                                                                                                                                                                                  |
| `columns`                | Tables: columns in the order of the values of every row, with their type in the source dialect. Generated (computed) columns are not stored. `delimiter`: PostgreSQL array element delimiter when it is not `,` (`box[]` uses `;`). |
| `rows`, `data`           | Tables: rows written, and each data file with its row count.                                                                                                                                                                        |
| `primaryKey`             | PostgreSQL tables: primary key columns.                                                                                                                                                                                             |
| `autoIncrement`          | MySQL tables: the `AUTO_INCREMENT` counter (also inside the DDL). SQLite: the table's `sqlite_sequence` value.                                                                                                                      |
| `indexes`                | PostgreSQL and SQLite: `CREATE INDEX` statements of indexes no constraint owns (MySQL keeps them inside the DDL).                                                                                                                   |
| `foreignKeys`            | PostgreSQL: `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` (MySQL keeps them inside the DDL).                                                                                                                                       |
| `triggers`               | Trigger statements of the table.                                                                                                                                                                                                    |
| `comments`               | PostgreSQL: `COMMENT ON …` statements.                                                                                                                                                                                              |
| `postDdl`                | PostgreSQL: statements that go right after the main one (constraints of a partition) or, for sequences, after every table exists (`ALTER SEQUENCE … OWNED BY …`).                                                                   |
| `sequences`              | PostgreSQL: sequence values to set after the data: `schema`, `name`, `lastValue` (integer text), `isCalled`, `ownedBy` (`{table, column}`), `kind` (`identity`, `serial`, `standalone`).                                            |
| `signature`              | PostgreSQL routines: identity arguments, to tell overloads apart.                                                                                                                                                                   |

### data-NNNNNN.jsonl.gz

gzip of UTF-8 text: one row per line, each line a JSON array with one value per column of
`meta.json`, in that order, and a final newline. A new file starts once the current one
reaches about 5 MB uncompressed, so readers never need much memory.

```jsonl vqb-rows
[1,"Ana",{"$dec":"1250.5000000000"},{"$bin":"/9j/4AAQ"},{"$dt":"2026-10-07 10:00:00.123456"},{"$json":"{\"vip\": true}"}]
[2,"Luis",{"$dec":"0.0000000001"},null,{"$dt":"2026-10-07 10:05:00.000000"},null]
```

## 6. Values

A value is JSON `null`, `true`/`false`, a number, a string, or a tagged object. Numbers
appear only when they are exact: integers between −(2^53−1) and 2^53−1, and finite floats.
Everything else is tagged:

| Tag          | Payload                                                                                            | Example                              |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `$bigint`    | Integer as text, outside the safe range.                                                           | `{"$bigint":"18446744073709551615"}` |
| `$dec`       | Exact decimal as the server wrote it (also `NaN`/`Infinity` of PostgreSQL `numeric`).              | `{"$dec":"123.4500"}`                |
| `$float`     | Non-finite float: `NaN`, `Infinity`, `-Infinity`. SQLite: also an integral `REAL` (`5`, `-0`).     | `{"$float":"NaN"}`                   |
| `$bin`       | Bytes, standard base64 with padding.                                                               | `{"$bin":"AAEC/w=="}`                |
| `$dt`        | Date, time or timestamp exactly as the server wrote it; no time-zone conversion.                   | `{"$dt":"2026-10-07 10:00:00.123"}`  |
| `$json`      | A JSON document **as text** (keeps big numbers, key order and, for PostgreSQL `json`, spacing).    | `{"$json":"{\"a\": 1}"}`             |
| `$arr`       | PostgreSQL array: nested JSON arrays, one level per dimension; each element is its text or `null`. | `{"$arr":["1",null,"a,b"]}`          |
| `$arr`+`$lb` | …with non-default bounds, as PostgreSQL prints them.                                               | `{"$arr":["7","8"],"$lb":"[0:1]"}`   |

The JSON string `"NULL"` is the text NULL, never SQL NULL.

```jsonl vqb-rows
[null,true,false,0,-9007199254740991,1.5,"texto","NULL"]
[{"$bigint":"-9223372036854775808"},{"$dec":"NaN"},{"$float":"-Infinity"},{"$bin":""},{"$dt":"23:59:59.999999"},{"$json":"[]"},{"$arr":[["1","2"],["3",null]]},{"$arr":["a"],"$lb":"[2:2]"}]
```

### MySQL and MariaDB

| Column types                                         | Value                                                   |
| ---------------------------------------------------- | ------------------------------------------------------- |
| `TINYINT`…`INT`, `YEAR`                              | number                                                  |
| `BIGINT` (signed or unsigned)                        | number when safe, `$bigint` otherwise                   |
| `DECIMAL`/`NUMERIC`                                  | `$dec`                                                  |
| `FLOAT`, `DOUBLE`                                    | number                                                  |
| `DATE`, `DATETIME`, `TIMESTAMP`, `TIME`              | `$dt` (`TIMESTAMP` text in `source.timeZone`, i.e. UTC) |
| `BINARY`, `VARBINARY`, `*BLOB`, `BIT`, spatial types | `$bin` (spatial: MySQL internal format, SRID + WKB)     |
| `JSON`                                               | `$json`                                                 |
| `CHAR`, `VARCHAR`, `*TEXT`, `ENUM`, `SET`            | string                                                  |

Restore: write the value as a literal: numbers, `$bigint` and `$dec` unquoted, `$bin` as
`0x…`, everything else as an escaped string; set the session `time_zone` to
`source.timeZone` first.

### PostgreSQL

| Column types                                                                                | Value                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `boolean`                                                                                   | `true`/`false`                            |
| `smallint`, `integer`, `oid`                                                                | number                                    |
| `bigint`                                                                                    | number when safe, `$bigint` otherwise     |
| `real`, `double precision`                                                                  | number, `$float` for NaN/±Infinity        |
| `numeric`; `money` (read as `numeric`, its text depends on `lc_monetary`)                   | `$dec`                                    |
| `date`, `time`, `timetz`, `timestamp`, `timestamptz`                                        | `$dt` (`timestamptz` includes its offset) |
| `bytea`                                                                                     | `$bin`                                    |
| `json`, `jsonb`                                                                             | `$json`                                   |
| arrays of any type                                                                          | `$arr`                                    |
| everything else (text, uuid, enums, domains, ranges, geometric, composite, interval, inet…) | string (the server's text form)           |

The text forms come from sessions with `DateStyle=ISO,MDY`, `IntervalStyle=postgres`,
`extra_float_digits=3` and `bytea_output=hex`. Restore: send every value as text and cast it
to the column type (`$1::public.mood`); `$bin` as `\x…`, `$arr` as an array literal with
every element double-quoted.

### SQLite

SQLite is dynamically typed: the value of each **cell** keeps its storage class, whatever the
column's declared type (`columns[].type` is the declared type as written, `""` when untyped).

| Storage class | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `INTEGER`     | number when safe, `$bigint` otherwise                                                   |
| `REAL`        | number with a fraction; `$float` when the value is integral (`5.0`, `-0.0`) or infinite |
| `TEXT`        | string                                                                                  |
| `BLOB`        | `$bin`                                                                                  |
| `NULL`        | `null`                                                                                  |

A bare integral JSON number is always an `INTEGER`. Restore: bind `INTEGER` values as 64-bit
integers, `REAL` as doubles, `$bin` as blobs and strings as text, so `typeof()` of every cell
comes back unchanged. `ddl.sql` is the `sql` text of `sqlite_schema` verbatim; a table's
`indexes` and `triggers` and a view's `triggers` (`INSTEAD OF`) hold their `sql` text too.
Rows are written in rowid order; rowids of tables without an `INTEGER PRIMARY KEY` are not
kept (they are renumbered on restore).

```jsonl vqb-rows
[1,{"$bigint":"9007199254740993"},2.5,{"$float":"1"}]
[{"$float":"-0"},"texto ñ",{"$bin":"AP8Q"},null]
```

### MongoDB

A collection is one object of type `collection` with a single column, `{"name": "document", "type":
"bson"}`. Each row holds one document as a `$json` value whose text is the document's **canonical Extended
JSON** (MongoDB Extended JSON v2, `relaxed: false`): every BSON type keeps its wrapper (`$oid`, `$date`
with `$numberLong`, `$numberInt`, `$numberLong`, `$numberDouble`, `$numberDecimal`, `$binary` with its
subtype, `$timestamp`, `$regularExpression`, `$minKey`, `$maxKey`, `$code`…), so an Int64 above 2^53, a
Decimal128 or the difference between an Int32 and a Double with an integral value survive, and field order
is kept. Documents are written in natural order.

`ddl.sql` is not SQL for this engine: it is the canonical Extended JSON of the `create` command that
recreates the object, built from `listCollections` (its `uuid` left out):

```json
{
  "create": "people",
  "validator": { "$jsonSchema": { "bsonType": "object", "required": ["name"] } },
  "validationLevel": "moderate"
}
```

A view's `ddl.sql` is `{"create": "<view>", "viewOn": "<collection>", "pipeline": [...]}`. A collection's
`indexes` (meta.json) holds the canonical Extended JSON of every index specification except `_id_`
(`{"key": {"name": {"$numberInt": "1"}}, "name": "name_u", "unique": true}`), without `v` and `ns`.

```jsonl vqb-rows
[
  {
    "$json": "{\"_id\":{\"$oid\":\"6ac6f781fc637c60b5590643\"},\"n\":{\"$numberLong\":\"9007199254740993\"}}"
  }
]
```

Restore: parse each document with an Extended JSON parser in canonical mode and insert it (Vortaq uses
`insertMany` in batches with `bypassDocumentValidation`, so documents written under an older validator come
back as they were). MongoDB has no snapshot across collections outside a transaction: each collection is read
as it is when its turn comes.

### Restore order

- MySQL/MariaDB: tables (DDL, rows, triggers, `AUTO_INCREMENT`), functions and procedures,
  views (retry those that depend on other views), events. A `DEFINER` whose account does not
  exist on the target may be dropped.
- PostgreSQL: schemas, extensions, types (retry those that depend on others), sequences,
  tables and their rows (partitioned parents first), functions and procedures, views and
  materialized views (retry), then every table's `indexes`, `foreignKeys`, `triggers`,
  sequences' `postDdl` and `setval` of `sequences`. Vortaq runs it all in one transaction
  with `search_path = pg_catalog` and `check_function_bodies = off`, and does not restore
  owners or privileges.
- MongoDB: collections (created with the options of `ddl.sql`), their documents, their `indexes`, then
  views. There is no transactional DDL: a failure stops the restore (unless «Continuar en caso de error») and
  leaves what was already restored; «Reemplazar la base de datos» takes a safety copy first and drops the
  database before restoring.
- SQLite: tables and their rows, `sqlite_sequence` values (`autoIncrement`), every table's
  `indexes`, views (archive order is creation order), then the `triggers` of tables and views.
  Vortaq runs it all in one transaction with `PRAGMA foreign_keys = OFF` (restored afterwards),
  either into a new file or, when replacing, after dropping every user object of the database
  (a `VACUUM INTO` copy of the file is taken first).

## 7. Encryption

Optional, chosen per backup. When `header.json` says `"encrypted": true`, **every entry
except `header.json` is encrypted**, `manifest.json` included. What stays visible: the
header, the number of entries, their sizes and their numbered paths (`objects/000003/…`).
No object, schema, database or connection name, and no value, is visible.

**Key.** `scrypt(password, salt, N, r, p, dkLen = 64)` where `password` is the UTF-8 bytes
of the password in Unicode NFC and `salt` is 16 random bytes (base64 in the header). Vortaq
uses N = 2^17, r = 8, p = 1 (128 MiB, under a second); readers accept N from 2^10 to 2^20,
r ≤ 32 and p ≤ 16. Bytes 0–31 are the AES-256 key. Bytes 32–63 are only used for
`keyCheck = base64(HMAC-SHA256(bytes 32–63, "vqb-key-check-v1"))`, stored in the header, so a
wrong password is detected before anything is decrypted and is not mistaken for damage.

**Encrypted entry ("VQE1" stream).**

```
offset 0   4 bytes   magic "VQE1"
offset 4   4 bytes   chunkSize, big-endian (65536)
offset 8   8 bytes   noncePrefix (random per entry)
offset 16  chunks    ciphertext (chunkSize bytes; the last chunk 0..chunkSize) + 16-byte GCM tag
```

- Chunk `i` (from 0) uses nonce = `noncePrefix ‖ uint32_be(i)` (12 bytes).
- Its additional authenticated data is the 16 header bytes ‖ the entry path in UTF-8 ‖
  `0x00` ‖ one byte that is `0x01` for the last chunk and `0x00` otherwise.
- Every chunk but the last is exactly `chunkSize + 16` bytes, so the last one is known from
  the entry size. An empty plaintext is a single final chunk holding only its tag.
- The path binds an entry to its name (entries cannot be swapped), the index fixes the
  order, and the final flag makes a truncated entry fail.

The plaintext of a data entry is its gzip stream; other entries are their JSON or SQL text.

## 8. Integrity

- `files[].sha256` is the SHA-256 of the entry **as stored** in the ZIP (after gzip and
  after encryption), so it can be checked without the password: `unzip -p x.vqb path |
sha256sum`.
- The ZIP CRC-32 of every entry, the GCM tag of every encrypted chunk and the gzip CRC of
  every data file are checked too; the row count of every data file must match `meta.json`,
  and their sum the manifest.
- Before an operation that drops anything (Vortaq's «Reemplazar la base de datos» and «Restaurar
  todo»), the whole file is read and checked first; a damaged or tampered file is refused
  while the target is untouched.

## 9. Versioning

- `formatVersion` is an integer. Readers refuse a version higher than the one they know,
  with a message asking to update.
- New optional fields may be added without changing the version; readers ignore fields they
  do not know. Anything that changes the meaning of an existing field, a value tag or the
  encryption scheme gets a new version.

## 10. Reading a .vqb without Vortaq

Unencrypted:

```sh
unzip -l backup.vqb                                   # entries
unzip -p backup.vqb manifest.json | jq '.objects[] | {type, name, rows}'
unzip -p backup.vqb objects/000001/ddl.sql
unzip -p backup.vqb objects/000001/data-000001.jsonl.gz | gunzip | head
```

Encrypted, in Python 3 with the `cryptography` package:

```python
import base64, gzip, hashlib, hmac, json, sys, unicodedata, zipfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def open_vqb(path, password):
    z = zipfile.ZipFile(path)
    header = json.loads(z.read("header.json"))
    if not header["encrypted"]:
        return z, None
    kdf = header["encryption"]["kdf"]
    raw = hashlib.scrypt(unicodedata.normalize("NFC", password).encode(),
                         salt=base64.b64decode(kdf["salt"]), n=kdf["N"], r=kdf["r"],
                         p=kdf["p"], dklen=64, maxmem=256 * kdf["N"] * kdf["r"] + 2**25)
    check = base64.b64encode(hmac.new(raw[32:], b"vqb-key-check-v1", hashlib.sha256).digest())
    if check.decode() != header["encryption"]["keyCheck"]:
        sys.exit("wrong password")
    return z, raw[:32]

def read_entry(z, key, path):
    data = z.read(path)
    if key is None:
        return data
    head, body = data[:16], data[16:]
    size = int.from_bytes(head[4:8], "big") + 16
    chunks = max(1, -(-len(body) // size))
    out = b""
    for i in range(chunks):
        piece = body[i * size:(i + 1) * size]
        aad = head + path.encode() + bytes([0, 1 if i == chunks - 1 else 0])
        out += AESGCM(key).decrypt(head[8:16] + i.to_bytes(4, "big"), piece, aad)
    return out

z, key = open_vqb(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "")
manifest = json.loads(read_entry(z, key, "manifest.json"))
for obj in manifest["objects"]:
    print(obj["type"], obj.get("schema", ""), obj["name"], obj["rows"])
    for f in obj["files"]:
        if f["path"].endswith(".jsonl.gz"):
            rows = gzip.decompress(read_entry(z, key, f["path"])).decode().splitlines()
            print("  ", f["path"], len(rows), "filas")
```

## 11. Limits of version 1

- PostgreSQL: owners, privileges (GRANT), row-level security policies, publications and
  subscriptions, foreign tables, aggregates, event triggers and table inheritance
  (`INHERITS`, restored as independent tables) are not included; extensions are recreated
  with `CREATE EXTENSION`, so the target server must have them installed.
- MariaDB: system-versioned tables and sequences are left out (listed in `warnings`).
- SQLite: virtual tables (FTS, R-Tree…) are left out (listed in `warnings`), and so are rowids
  of tables without an `INTEGER PRIMARY KEY`.
- MongoDB: users, roles and `system.*` collections are not included; a backup is not a point-in-time
  snapshot of the whole database (each collection is read in turn).
- Restores go to the same engine only.
