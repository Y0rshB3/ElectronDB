# Job editor (2.0.1)

The automation job editor (`src/renderer/src/views/JobEditorView.vue`) follows a
browse-and-pick workflow: choose what kind of step to add, browse connection ›
database for things to run, add them to the job's sequence, order them and set
the schedule. Every item added becomes an ordinary `JobTask` (`src/shared/types.ts`),
so jobs saved by earlier versions (and Navicat batch jobs imported into Vortaq)
open and save exactly as before. The only step kind added is «Restaurar paquete»
(`restorepackage`, see below); a job without one is byte-identical to before.

## Layout

```
header   [icon] Name (inline)  pills: engines · environments · Navicat
                               (schedule chip) (last run)  Ejecutar ahora  Guardar
sections Pasos · Programación · Opciones · Historial

Pasos    ┌ Secuencia de pasos ─────────────────────┐ ┌ settings of the    ┐
         │ ⋮ 1 Copia  Backup ventas  Local  ventas │ │ selected step      │
         │ ⋮ 2 …                                   │ │ (floats over the   │
         ├ Añadir pasos [Copia|Consulta|SQL|Rest.]  │ │ steps when the     │
         │                     (Copiar y restaurar)│ │                    │
         │ filter + connection › db │ items (✓ + ⇢) │ │ editor is narrow)  │
         │ hint of the kind               Añadir(n)│ │                    │
         └─────────────────────────────────────────┘ └────────────────────┘
```

- **Header** — the job name is edited in place; pills summarise the engines and
  environments the steps touch and whether the job came from Navicat; the
  schedule chip («Todos los días a las 02:00», «Sin programar», «Programación no
  válida») opens Programación; the last-run status opens Historial. The header
  wraps to two rows in narrow editors.
- **Pasos** — `components/automation/JobStepList.vue`: one compact row per step
  (number, type, name and a short detail such as `.vqb · cifrada`, the first SQL
  line or the restore source, connection with engine icon and environment pill,
  database). Steps without a typed name show a default one built from their
  connection: «Copia de ventas (Staging)», «Restaurar ventas en Local»
  (`defaultReferenceName(task, tasks, nameOf)`, `shared/jobRecipes.ts`); restore rows
  always say «con copia previa» or «sin copia previa». A default name follows the
  step when its connection, database or source changes (`hasAutoName`); a name the
  user typed stays. Rows reorder by dragging, with the hover buttons (subir, bajar,
  duplicar, quitar) or from the keyboard (↑/↓ move focus, Alt+↑/↓ move the step,
  Supr removes, Intro opens its settings). Step problems (the same messages as
  `validateDraft`, through `taskProblems`) show on the row as hints and turn into
  errors after a save attempt; a failed save opens the first failing step.
- **Settings panel** — `JobStepSettings.vue` holds every option the inline forms
  had: type, reference name, connection/database, format .vqb/.nb3/.sql per engine
  (`shared/jobEngines.ts`), include data, encryption, restore source (earlier
  backup step or «última copia» of a connection/database), target connection and
  database (targets that need the typed name are listed but disabled), content
  (structure and data / structure only), safety copy, SQL editor. Esc closes it.
- **Añadir pasos** — `JobStepBrowser.vue` with the pure rules in `jobSteps.ts`:
  - _Copia de seguridad_: the databases of the selected connection (every engine
    that can back up). With the connection selected (not a database) a first item
    «Todas las bases de datos de Staging» adds one backup step per database (system
    databases excluded; those already in the job are skipped). A backup step copies
    one database; the copies of one run are grouped as a package in Historial
    («Restaurar paquete en Local», «Restaurar todo en X»), so no multi-database step
    was added.
  - _Consulta guardada_: the saved queries of the connection (or of the selected
    database). The step stores a copy of the SQL and takes the query's name.
    Listing them needs no connection.
  - _SQL libre_: an empty query step in the connection or one of its databases.
  - _Restauración_, grouped by automation:
    - **Esta tarea**: a package header «Paquete de esta tarea · 15 copias» (fold
      chevron, tri-state checkbox, the source connections as engine/environment
      pills, an arrow to the default target and «se restaura en Local con copia
      previa») with the backup steps of this job inside (restorable formats only),
      named by what they copy («Copia de ventas (Staging) — estructura y datos»,
      «Paso 1 · .vqb · se restaura en Local con copia previa»). Adding the header
      (or checking every copy) adds ONE «Restaurar paquete» step; checking some
      copies adds one restore step per copy, as before.
    - **Otras tareas**: one folded group per other job that copies databases with
      data (`jobs:packages`): «Copia nocturna Staging · último paquete (2026-10-07
      02:00, 15 copias)», or «aún sin paquete» before its first run (its backup
      steps are listed then). Its items are the databases of that package; the
      header adds a package step of «todas», some checked items one package step
      with just those databases.
    - **Copias en disco de Local**, for a selected connection/database:
      «Última copia de auth · Local» and the job copies found on disk.
    A job without backup steps gets a suggestion that opens «Copiar y restaurar».
    The target defaults to a local connection of the same engine that does not
    need the typed name, and is changed in the step settings.
    Query kinds list MySQL/MariaDB connections only. System databases are hidden
    (`isHiddenDatabase`: MySQL system schemas, `template0/1`, `admin/local/config`,
    SQLite `temp`). A connection is opened only when the user picks or expands it
    (saved queries never open it). Items are added with a double click, Intro, the
    row's `+`, «Añadir (n)» after checking several (espacio, or «Seleccionar todo»
    above each list: tri-state, a real checkbox in the tab order), or by dragging them
    onto the sequence at the drop position. Repeated backups of one database in a
    batch are added once (`dedupeSteps`). The browser folds to its header to give
    the sequence the whole height.
- **Copiar y restaurar** — `CopyRestoreDialog.vue` with the pure recipe in
  `shared/jobRecipes.ts` (shared so the integration suite runs a job built by it).
  Opened from the button in the «Añadir pasos» header (the selected connection is
  proposed as origin), from the empty sequence («¿Llevar Staging a Local cada
  noche?») and from the Restauración suggestion. The user picks the origin
  connection (opened only then) and its databases (all by default, «Seleccionar
  todo» and one by one), the destination connection (first local one of the same
  engine; targets that need the typed name are listed disabled with the reason),
  the destination name per database (same name by default, or a suffix for all),
  «Copia previa del destino» (con / sin, explained in one sentence), the content
  (estructura y datos / solo estructura) and «Restauración»: «Un paso «Restaurar
  paquete»» (default) or «Un paso por base de datos». It adds every backup step
  (.vqb) and then either one package step of this job's package listing exactly
  those databases (`packageDatabases`, renamed ones in `packageTargets`) or one
  restore step per database reading «la copia del paso N». The steps are checked
  with the job's own rules (`taskProblems`) before they can be added.
- **Restaurar paquete** — `restorepackage` steps (`shared/restorePackage.ts`, shared
  by the editor, `jobs:save` and the runner). `connectionId` is the target;
  `packageSource` is `{ kind: 'own' }` (the restorable backup steps placed before
  it, copied in this same run) or `{ kind: 'job', jobId, jobName? }` (the newest
  successful, non-rollback run of that job with restorable copies, looked up when
  the step runs, `automation/jobPackages.ts`; a newer failed run never replaces a
  complete package, and a partial one is used only when the job never ended a run
  well, with a warning in the log). `packageDatabases` absent means
  «Todas» (databases the package gains later are included); `packageTargets`
  renames single databases and `packageSuffix` applies to the rest. Structure-only
  copies are left out of «Todas» unless the step restores the structure only.
  Row: «Restaurar paquete de «Copia nocturna Staging» en Local · 15 bases (todas) ·
  con copia previa». Settings: package select (this job or the latest package of
  each other job, with its date and copies), Todas / Solo las marcadas, sufijo,
  one target field per database, target connection, content and «Copia previa del
  destino» (con / sin). When it runs, the runner checks the whole package first
  (target, guarded environments, missing databases, engines, name collisions,
  structure-only copies picked by name, every restore's own rules, that each copy
  was made in this run or is still on disk, and that a stored password opens each
  encrypted copy) and restores nothing if any check fails; otherwise it replaces the step in the run by
  one ordinary restore per database (`packageRestoreTasks`, ids `<step>#<n>`, run
  entries carry `packageStepId`), so each database gets the restore rules, safety
  copy, log heading and history line of a restore step. Another job's copies are
  opened with that job's stored backup password.
- **Programación** — the schedule builder and «Ejecutar aunque la app esté
  cerrada», unchanged in behaviour.
- **Opciones** — «Continuar en caso de error», the job's backup password (only
  while a step encrypts; stored through `CredentialStore`, never returned to the
  renderer) and the Navicat origin of imported jobs.
- **Historial** — the run list next to the log of the selected run.

The browser has its own small tree instead of the sidebar's `ConnectionTree`:
the sidebar tree keeps selection, expansion and filters in the shared `tree`
store, and browsing inside the editor must not move the user's place there.

## Rules kept

- Typed confirmation: running or scheduling SQL on guarded connections still asks
  through `useJobProductionGuard`, and restore and package steps can never target a
  connection that needs the typed name (disabled in the target list, refused by
  `restoreTaskProblem` / `restorePackageProblem`, by `jobs:save`, `jobs:run` and
  again by the runner). System databases are never targets, and a copy only
  restores into its own engine.
- Per-engine step rules come from `shared/jobEngines.ts` in the browser (kinds
  and formats offered) and in validation.
- Viewing a job never opens a connection: database lists load only for
  connections already open, or when the user picks one.

## Independent design

The workflow (pick a kind, browse, add, order, schedule) is a common pattern of
batch-job tools; the presentation is Vortaq's own: the existing `nd-*` tokens,
glass cards, pills and icons, Spanish wording written for Vortaq, a header with
summary chips instead of a toolbar, a horizontal segmented control of step kinds
instead of a vertical type list, a two-column browser (tree and items) below the
sequence instead of equal panes, a side panel for step settings, and sections
named after what they hold (Pasos, Programación, Opciones, Historial).
