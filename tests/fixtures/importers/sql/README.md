# SQL dump fixtures (synthetic)

Every file here was written by hand for the tests of `src/main/importers/sql/`
and `src/shared/dialects/mysqlStream.ts`. They imitate the *layout* of dumps
written by common tools (mysqldump, phpMyAdmin, HeidiSQL, Adminer, DBeaver's
mysqldump task, MySQL Workbench forward engineering, TablePlus) using public
MySQL syntax only: conditional comments, `DELIMITER`, `LOCK TABLES`, extended
`INSERT`s. No file was produced by those tools, and no host, user or data is
real (accounts such as `app_owner` and addresses ending in `.invalid` are made
up).

`.sql.gz` variants are generated inside the tests with `zlib`; none is committed.

The integration test (`tests/integration/sqlImport.test.ts`) uses real
`mysqldump` output generated at test time from a seeded throwaway schema.
