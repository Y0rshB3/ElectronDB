# Import fixtures (synthetic)

Every file under this folder is **synthetic**: written by hand from public
descriptions of each format (product documentation and the formats' publicly
described structure). They contain no real hosts, users, passwords or data: hosts use
`*.example.test`, private addresses or loopback; users are made-up names.

| Folder       | Format                                                                 | Used by                                    |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------ |
| `ncx/`       | Navicat «Export Connections» (`.ncx`), versions 1.4 and 1.5            | `src/main/importers/connections/*.test.ts` |
| `dbeaver/`   | DBeaver workspace `.dbeaver/data-sources.json`                         | `src/main/importers/connections/*.test.ts` |
| `workbench/` | MySQL Workbench `connections.xml` (GRT XML)                            | `src/main/importers/connections/*.test.ts` |
| `sql/`       | SQL dumps in the styles of several tools (see its own README)          | SQL dump import tests                      |

- No `.ncx` file here carries passwords: the tests that need them build the
  file in memory and encrypt the values with `ncxCipher.ts`.
- The Workbench file has a `password` key on purpose: the importer must ignore it.
- DBeaver's encrypted `credentials-config.json` is never read, so there is no
  fixture for it.
