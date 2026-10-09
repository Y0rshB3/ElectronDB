# Job editor (2.0.1)

The automation job editor (`src/renderer/src/views/JobEditorView.vue`) follows a
browse-and-pick workflow: choose what kind of step to add, browse connection ›
database for things to run, add them to the job's sequence, order them and set
the schedule. The job model (`Job`, `JobTask` in `src/shared/types.ts`), the IPC
channels and the runner are unchanged: every item added becomes an ordinary
`JobTask`, so jobs saved by earlier versions (and Navicat batch jobs imported
into Vortaq) open and save exactly as before.

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
  - _Restauración_: the backup steps of this job (restorable formats only), named by
    what they copy («Copia de ventas (Staging) — estructura y datos») and where the
    restore lands by default («Paso 1 · .vqb · se restaura en Local con copia previa»),
    and, for a selected connection/database, «Copias en disco de Local» with
    «Última copia de auth · Local» and the job copies found on disk. A job without
    backup steps gets a suggestion that opens «Copiar y restaurar». The target defaults to a local connection of the same engine
    that does not need the typed name, and is changed in the step settings.
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
  «Copia previa del destino» (con / sin, explained in one sentence) and the content
  (estructura y datos / solo estructura). It adds every backup step (.vqb) and then
  every restore step reading «la copia del paso N»; each restore is checked with the
  job's own rules (`taskProblems`) before it can be added. Nothing new is stored:
  the result is ordinary steps.
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
  through `useJobProductionGuard`, and restore steps can never target a connection
  that needs the typed name (disabled in the target list, refused by
  `restoreTaskProblem` and again by main).
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
