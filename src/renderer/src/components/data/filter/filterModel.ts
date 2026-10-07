import type {
  TableFilter,
  TableFilterCondition,
  TableFilterGroup,
  TableFilterJoin,
  TableFilterNode,
  TableFilterOperator
} from '@shared/types'

/**
 * UI model of the visual filter builder: a tree of conditions and
 * brackets, each item carrying the connector ("y"/"o") to its next sibling.
 * Pure data, labels and tree edits; the SQL is built (and escaped) by the main
 * process from the TableFilter sent over IPC.
 */

/** How many value tokens an operator takes. */
export type OperatorArity = 'none' | 'one' | 'two' | 'list' | 'sql'

export interface OperatorInfo {
  value: TableFilterOperator
  label: string
  arity: OperatorArity
}

export const FILTER_OPERATORS: readonly OperatorInfo[] = [
  { value: 'eq', label: '=', arity: 'one' },
  { value: 'ne', label: '!=', arity: 'one' },
  { value: 'lt', label: '<', arity: 'one' },
  { value: 'le', label: '<=', arity: 'one' },
  { value: 'gt', label: '>', arity: 'one' },
  { value: 'ge', label: '>=', arity: 'one' },
  { value: 'contains', label: 'contiene', arity: 'one' },
  { value: 'notContains', label: 'no contiene', arity: 'one' },
  { value: 'beginsWith', label: 'empieza por', arity: 'one' },
  { value: 'notBeginsWith', label: 'no empieza por', arity: 'one' },
  { value: 'endsWith', label: 'termina en', arity: 'one' },
  { value: 'notEndsWith', label: 'no termina en', arity: 'one' },
  { value: 'isNull', label: 'es nulo', arity: 'none' },
  { value: 'isNotNull', label: 'no es nulo', arity: 'none' },
  { value: 'isEmpty', label: 'está vacío', arity: 'none' },
  { value: 'isNotEmpty', label: 'no está vacío', arity: 'none' },
  { value: 'in', label: 'está en la lista', arity: 'list' },
  { value: 'notIn', label: 'no está en la lista', arity: 'list' },
  { value: 'between', label: 'entre', arity: 'two' },
  { value: 'notBetween', label: 'no entre', arity: 'two' },
  { value: 'custom', label: 'SQL libre', arity: 'sql' }
]

const BY_VALUE = new Map(FILTER_OPERATORS.map((o) => [o.value, o]))

export function operatorInfo(op: TableFilterOperator): OperatorInfo {
  return BY_VALUE.get(op) ?? FILTER_OPERATORS[0]
}

export const CONNECTOR_LABEL: Record<TableFilterJoin, string> = { AND: 'y', OR: 'o' }

export interface FilterConditionState {
  id: string
  kind: 'condition'
  enabled: boolean
  column: string
  operator: TableFilterOperator
  values: string[]
  connector: TableFilterJoin
  sql: string
}

export interface FilterGroupState {
  id: string
  kind: 'group'
  enabled: boolean
  connector: TableFilterJoin
  children: FilterNodeState[]
}

export type FilterNodeState = FilterConditionState | FilterGroupState

export interface FilterPanelState {
  mode: 'builder' | 'text'
  /** Root bracket (not rendered as a bracket). */
  root: FilterGroupState
  /** Raw WHERE text of the text mode. */
  text: string
  /** WHERE main generated for the builder when switching to text: tells edited text apart. */
  generatedText: string | null
  /** Highlighted line (condition or bracket id). */
  selectedId: string | null
  /** Filter profile loaded or last saved ("Guardar perfil" overwrites it). */
  profile: string | null
}

export type FilterConditionPatch = Partial<
  Pick<FilterConditionState, 'enabled' | 'column' | 'operator' | 'values' | 'connector' | 'sql'>
>

let seq = 0
function nextId(prefix: string): string {
  return `${prefix}${++seq}-${Date.now().toString(36)}`
}

export function newCondition(column = ''): FilterConditionState {
  return {
    id: nextId('f'),
    kind: 'condition',
    enabled: true,
    column,
    operator: 'eq',
    values: [],
    connector: 'AND',
    sql: ''
  }
}

export function newGroup(children: FilterNodeState[] = []): FilterGroupState {
  return { id: nextId('g'), kind: 'group', enabled: true, connector: 'AND', children }
}

export function emptyFilterState(): FilterPanelState {
  return {
    mode: 'builder',
    root: newGroup(),
    text: '',
    generatedText: null,
    selectedId: null,
    profile: null
  }
}

/* ---------- tree navigation and edits (in place, on reactive state) ---------- */

export interface Located {
  parent: FilterGroupState
  index: number
  node: FilterNodeState
}

export function locate(root: FilterGroupState, id: string): Located | null {
  for (let index = 0; index < root.children.length; index++) {
    const node = root.children[index]
    if (node.id === id) return { parent: root, index, node }
    if (node.kind === 'group') {
      const found = locate(node, id)
      if (found) return found
    }
  }
  return null
}

export function findCondition(root: FilterGroupState, id: string): FilterConditionState | null {
  const found = locate(root, id)
  return found?.node.kind === 'condition' ? found.node : null
}

/**
 * Where "Insertar" puts a new item for the clicked line: inside a bracket
 * (appended), after a condition (same level), or at the end of the root.
 */
function insertionPoint(
  root: FilterGroupState,
  targetId: string | null
): { parent: FilterGroupState; index: number } {
  const found = targetId ? locate(root, targetId) : null
  if (!found) return { parent: root, index: root.children.length }
  if (found.node.kind === 'group') return { parent: found.node, index: found.node.children.length }
  return { parent: found.parent, index: found.index + 1 }
}

export function insertCondition(
  root: FilterGroupState,
  targetId: string | null,
  column: string
): FilterConditionState {
  const { parent, index } = insertionPoint(root, targetId)
  const node = newCondition(column)
  parent.children.splice(index, 0, node)
  return node
}

/** "Insertar paréntesis": a new bracket holding one empty condition. */
export function insertGroup(
  root: FilterGroupState,
  targetId: string | null,
  column: string
): FilterGroupState {
  const { parent, index } = insertionPoint(root, targetId)
  const node = newGroup([newCondition(column)])
  parent.children.splice(index, 0, node)
  return node
}

/** "Agrupar con paréntesis": the bracket takes the item's place and its connector. */
export function wrapInGroup(root: FilterGroupState, id: string): FilterGroupState | null {
  const found = locate(root, id)
  if (!found) return null
  const group = newGroup([found.node])
  group.connector = found.node.connector
  found.node.connector = 'AND'
  found.parent.children.splice(found.index, 1, group)
  return group
}

/** "Borrar condición" / "Borrar paréntesis y condiciones". */
export function removeNode(root: FilterGroupState, id: string): boolean {
  const found = locate(root, id)
  if (!found) return false
  found.parent.children.splice(found.index, 1)
  return true
}

/**
 * "Borrar paréntesis": its items move up one level in its place; the last one
 * takes the bracket's connector so the sentence keeps reading the same.
 */
export function unwrapGroup(root: FilterGroupState, id: string): boolean {
  const found = locate(root, id)
  if (!found || found.node.kind !== 'group') return false
  const children = found.node.children
  if (children.length) children[children.length - 1].connector = found.node.connector
  found.parent.children.splice(found.index, 1, ...children)
  return true
}

/* ---------- rendering as lines ---------- */

export type FilterLine =
  | { type: 'condition'; node: FilterConditionState; depth: number; hasNext: boolean }
  | { type: 'open'; node: FilterGroupState; depth: number }
  | { type: 'close'; node: FilterGroupState; depth: number; hasNext: boolean }

/** Flattens the tree into the lines of the panel (brackets get an opening and a closing line). */
export function filterLines(root: FilterGroupState, depth = 0): FilterLine[] {
  const lines: FilterLine[] = []
  root.children.forEach((node, i) => {
    const hasNext = i < root.children.length - 1
    if (node.kind === 'condition') {
      lines.push({ type: 'condition', node, depth, hasNext })
    } else {
      lines.push({ type: 'open', node, depth })
      lines.push(...filterLines(node, depth + 1))
      lines.push({ type: 'close', node, depth, hasNext })
    }
  })
  return lines
}

/* ---------- validation and serialisation ---------- */

/** Splits "a, b ,c" or one value per line into trimmed non-empty items. */
export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/** Why an enabled condition cannot be applied yet, or null when it is complete. */
export function conditionProblem(node: FilterConditionState): string | null {
  const { arity } = operatorInfo(node.operator)
  if (arity === 'sql') return node.sql.trim() ? null : 'Escribe la condición SQL'
  if (!node.column) return 'Elige una columna'
  const [a = '', b = ''] = node.values
  if (arity === 'one' && a === '') return 'Falta el valor'
  if (arity === 'two' && (a === '' || b === '')) return 'Faltan los dos valores'
  if (arity === 'list' && !node.values.some((v) => v !== '')) return 'Añade al menos un valor'
  return null
}

/** Conditions that reach the WHERE (enabled, inside enabled brackets). */
export function activeConditions(group: FilterGroupState): FilterConditionState[] {
  if (!group.enabled) return []
  return group.children.flatMap((node) =>
    node.kind === 'group' ? activeConditions(node) : node.enabled ? [node] : []
  )
}

/** First problem among the active conditions (blocks "Aplicar filtro"), with its id. */
export function filterProblem(root: FilterGroupState): { id: string; message: string } | null {
  for (const node of activeConditions(root)) {
    const message = conditionProblem(node)
    if (message) return { id: node.id, message }
  }
  return null
}

function toCondition(node: FilterConditionState): TableFilterCondition {
  const base = {
    kind: 'condition' as const,
    enabled: node.enabled,
    column: node.column,
    operator: node.operator,
    connector: node.connector
  }
  switch (operatorInfo(node.operator).arity) {
    case 'one':
      return { ...base, values: [node.values[0] ?? ''] }
    case 'two':
      return { ...base, values: [node.values[0] ?? '', node.values[1] ?? ''] }
    case 'list':
      return { ...base, values: node.values.filter((v) => v !== '') }
    case 'sql':
      return { ...base, column: '', values: [], sql: node.sql }
    default:
      return { ...base, values: [] }
  }
}

function toGroup(node: FilterGroupState): TableFilterGroup {
  return {
    kind: 'group',
    enabled: node.enabled,
    connector: node.connector,
    children: node.children.map((c): TableFilterNode =>
      c.kind === 'group' ? toGroup(c) : toCondition(c)
    )
  }
}

/** IPC payload for the builder (plain data, no UI ids). */
export function toTableFilter(root: FilterGroupState): TableFilter {
  return toGroup(root)
}

/** Builder state for a stored filter (profile), with fresh UI ids. */
export function fromTableFilter(filter: TableFilter): FilterGroupState {
  const convert = (node: TableFilterNode): FilterNodeState | null => {
    if (!node || typeof node !== 'object') return null
    if (node.kind === 'group') {
      const group = newGroup(
        (Array.isArray(node.children) ? node.children : [])
          .map(convert)
          .filter((c): c is FilterNodeState => !!c)
      )
      group.enabled = node.enabled !== false
      group.connector = node.connector === 'OR' ? 'OR' : 'AND'
      return group
    }
    if (node.kind !== 'condition' || !BY_VALUE.has(node.operator)) return null
    return {
      ...newCondition(typeof node.column === 'string' ? node.column : ''),
      enabled: node.enabled !== false,
      operator: node.operator,
      values: Array.isArray(node.values) ? node.values.map(String) : [],
      connector: node.connector === 'OR' ? 'OR' : 'AND',
      sql: typeof node.sql === 'string' ? node.sql : ''
    }
  }
  const root = convert(filter)
  return root && root.kind === 'group' ? root : newGroup()
}

/** Deep copy for persisting in the tab payload (no shared references with the live state). */
export function cloneFilterState(state: FilterPanelState): FilterPanelState {
  return JSON.parse(JSON.stringify(state)) as FilterPanelState
}

function isGroupState(value: unknown): value is FilterGroupState {
  const v = value as FilterGroupState | null
  return !!v && typeof v === 'object' && v.kind === 'group' && Array.isArray(v.children)
}

/** Accepts a state restored from the tab payload, or a fresh one when it is missing/invalid. */
export function restoreFilterState(value: unknown): FilterPanelState {
  const v = value as Partial<FilterPanelState> | null | undefined
  if (!v || typeof v !== 'object' || !isGroupState(v.root)) return emptyFilterState()
  const copy = cloneFilterState(v as FilterPanelState)
  return {
    ...emptyFilterState(),
    ...copy,
    mode: v.mode === 'text' ? 'text' : 'builder',
    text: typeof v.text === 'string' ? v.text : '',
    profile: typeof v.profile === 'string' ? v.profile : null
  }
}
