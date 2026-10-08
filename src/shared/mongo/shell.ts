/**
 * MongoDB query-tab grammar (docs/multi-engine-design.md, D9 and 9.3).
 *
 * A whitelist, not an interpreter: acorn parses the script, and every
 * top-level statement must be one call chain such as
 * `db.orders.find({…}).sort({…}).limit(10)`, `db.getCollection('a-b').count()`,
 * `db.stats()` or `rs.status()`; `use <db>` and `show dbs|collections` lines
 * are recognised before parsing. Arguments stay source slices: main parses
 * each one with @mongodb-js/shell-bson-parser in strict mode. User text is
 * never eval'd, vm'd or Function'd.
 *
 * Pure (acorn only), so the renderer and main share it: the renderer's
 * production-guard dialog and main's guard read the same parse.
 */
import { parse as acornParse, tokenizer } from 'acorn'
import type {
  CallExpression,
  Expression,
  ExpressionStatement,
  Literal,
  MemberExpression,
  Node,
  Property,
  SpreadElement
} from 'acorn'

export class MongoShellError extends Error {
  constructor(
    message: string,
    /** 0-based offset into the script. */
    readonly position: number
  ) {
    super(message)
    this.name = 'MongoShellError'
  }
}

/** One argument of a call. Strings and numbers are read from the AST; the rest stays text. */
export type MongoArg =
  | { kind: 'string'; value: string; start: number; end: number }
  | { kind: 'number'; value: number; raw: string; start: number; end: number }
  | { kind: 'boolean'; value: boolean; start: number; end: number }
  | { kind: 'null'; start: number; end: number }
  | {
      kind: 'expr'
      /** Source slice, parsed in main by shell-bson-parser (strict). */
      source: string
      start: number
      end: number
      /** Only literal nodes and whitelisted BSON constructors (so the text says what it is). */
      literal: boolean
      /** Every property key and string literal of the argument, decoded (`$out` → `$out`). */
      strings: string[]
      /** An empty object literal `{}`. */
      empty: boolean
    }

export interface MongoCall {
  name: string
  args: MongoArg[]
  start: number
  end: number
}

interface StatementBase {
  /** Source text of the statement. */
  text: string
  start: number
  end: number
}

export type MongoStatement =
  | (StatementBase & { type: 'use'; database: string })
  | (StatementBase & { type: 'show'; what: 'dbs' | 'collections' })
  | (StatementBase & {
      type: 'db'
      /** db.getSiblingDB('x'): the database of this statement only. */
      database: string | null
      method: string
      args: MongoArg[]
    })
  | (StatementBase & { type: 'rs'; method: string; args: MongoArg[] })
  | (StatementBase & {
      type: 'collection'
      database: string | null
      collection: string
      method: string
      args: MongoArg[]
      /** Chained modifiers after the method (`.sort(…)`, `.limit(…)`, `.pretty()`…). */
      chain: MongoCall[]
      /** `db.c.explain(v).find(…)` or `.find(…).explain(v)`: the verbosity argument (or null). */
      explain: { verbosity: MongoArg | null } | null
    })

/** Collection methods that only read. */
export const COLLECTION_READ_METHODS = [
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'count',
  'distinct',
  'getIndexes',
  'stats'
] as const

/** Collection methods that write (P4b), always guarded on production. */
export const COLLECTION_WRITE_METHODS = [
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'bulkWrite',
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'drop',
  'renameCollection'
] as const

/** Database methods that only read (read-only commands of section 9.3). */
export const DB_READ_METHODS = [
  'stats',
  'version',
  'getName',
  'getCollectionNames',
  'getCollectionInfos',
  'serverStatus',
  'currentOp'
] as const

/** Database methods that write. */
export const DB_WRITE_METHODS = ['createCollection', 'dropDatabase'] as const

export const RS_METHODS = ['status'] as const

const COLLECTION_METHODS = new Set<string>([
  ...COLLECTION_READ_METHODS,
  ...COLLECTION_WRITE_METHODS
])
const DB_METHODS = new Set<string>([...DB_READ_METHODS, ...DB_WRITE_METHODS])

/** Cursor modifiers of find(). */
const FIND_MODIFIERS = new Set([
  'sort',
  'limit',
  'skip',
  'project',
  'projection',
  'hint',
  'collation',
  'maxTimeMS',
  'comment',
  'batchSize',
  'allowDiskUse'
])
/** Pasted-shell tolerance: no-ops, or a terminal count. */
const NOOP_MODIFIERS = new Set(['pretty', 'toArray'])
const COUNT_MODIFIERS = new Set(['count', 'itcount', 'size'])
/** Methods `explain` can wrap. */
const EXPLAINABLE = new Set(['find', 'findOne', 'aggregate', 'count', 'countDocuments', 'distinct'])

/** BSON constructors shell-bson-parser understands (a call to one of these is a literal). */
export const BSON_CONSTRUCTORS = new Set([
  'ObjectId',
  'ObjectID',
  'ISODate',
  'Date',
  'NumberLong',
  'NumberInt',
  'NumberDecimal',
  'Long',
  'Int32',
  'Double',
  'Decimal128',
  'UUID',
  'BinData',
  'Binary',
  'Timestamp',
  'MinKey',
  'MaxKey',
  'RegExp',
  'Code',
  'DBRef',
  'Symbol',
  'BSONRegExp',
  'BSONSymbol',
  'HexData',
  'MD5'
])
const LITERAL_IDENTIFIERS = new Set(['undefined', 'NaN', 'Infinity'])

/* ---------- special lines ---------- */

const USE_LINE = /^[ \t]*use[ \t]+([^\s;]+)[ \t]*;?[ \t]*$/
const SHOW_LINE = /^[ \t]*show[ \t]+(dbs|databases|collections|tables)[ \t]*;?[ \t]*$/

interface Masked {
  text: string
  specials: MongoStatement[]
}

/**
 * Ranges of comments, strings and template literals: a `use x` line inside one
 * of them is text, not a command. Best effort: when the script does not even
 * tokenize, nothing is excluded (the parse then reports the syntax error).
 */
function quotedRanges(script: string): [number, number][] {
  const ranges: [number, number][] = []
  try {
    const tokens = tokenizer(script, {
      ecmaVersion: 'latest',
      onComment: (_block, _text, start, end) => {
        ranges.push([start, end])
      }
    })
    for (const token of tokens) {
      const label = token.type.label
      if (label === 'string' || label === 'template' || label === '`' || label === 'regexp')
        ranges.push([token.start, token.end])
    }
  } catch {
    // Unterminated comment or string: treat the rest of the script as quoted from its start.
    const open = /\/\*|`/.exec(script)
    if (open) ranges.push([open.index, script.length])
  }
  return ranges
}

/** Blanks out `use`/`show` lines (same length, so offsets stay valid) and records them. */
function maskSpecialLines(script: string): Masked {
  const specials: MongoStatement[] = []
  const quoted = quotedRanges(script)
  const inQuoted = (at: number): boolean => quoted.some(([a, b]) => at > a && at < b)
  let out = ''
  let offset = 0
  for (const line of script.split('\n')) {
    const use = USE_LINE.exec(line)
    const show = use ? null : SHOW_LINE.exec(line)
    const lineStart = offset + (line.length - line.trimStart().length)
    if ((use || show) && !inQuoted(lineStart)) {
      const lead = line.length - line.trimStart().length
      const text = line.trim()
      const base = { text, start: offset + lead, end: offset + lead + text.length }
      if (use) specials.push({ ...base, type: 'use', database: use[1].replace(/^['"]|['"]$/g, '') })
      else
        specials.push({
          ...base,
          type: 'show',
          what: show![1] === 'dbs' || show![1] === 'databases' ? 'dbs' : 'collections'
        })
      out += ' '.repeat(line.length)
    } else out += line
    out += '\n'
    offset += line.length + 1
  }
  return { text: out.slice(0, -1), specials }
}

/* ---------- arguments ---------- */

function argOf(node: Expression | SpreadElement, script: string): MongoArg {
  if (node.type === 'SpreadElement')
    throw new MongoShellError('No se admite el operador de propagación (...).', node.start)
  const { start, end } = node
  if (node.type === 'Literal') {
    const lit = node as Literal
    if (typeof lit.value === 'string') return { kind: 'string', value: lit.value, start, end }
    if (typeof lit.value === 'number')
      return { kind: 'number', value: lit.value, raw: lit.raw ?? String(lit.value), start, end }
    if (typeof lit.value === 'boolean') return { kind: 'boolean', value: lit.value, start, end }
    if (lit.value === null && !lit.regex) return { kind: 'null', start, end }
  }
  if (
    node.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument.type === 'Literal' &&
    typeof node.argument.value === 'number'
  )
    return {
      kind: 'number',
      value: -node.argument.value,
      raw: script.slice(start, end),
      start,
      end
    }
  const info = inspect(node)
  return {
    kind: 'expr',
    source: script.slice(start, end),
    start,
    end,
    literal: info.literal,
    strings: info.strings,
    empty: node.type === 'ObjectExpression' && node.properties.length === 0
  }
}

/** Walks an argument: is it made only of literals, and which keys/strings does it mention? */
function inspect(root: Node): { literal: boolean; strings: string[] } {
  const strings: string[] = []
  let literal = true
  const visit = (node: Node | null | undefined, asKey = false): void => {
    if (!node) {
      literal = false // array holes
      return
    }
    switch (node.type) {
      case 'ObjectExpression':
        for (const p of (node as unknown as { properties: (Property | SpreadElement)[] })
          .properties) {
          if (p.type !== 'Property' || p.kind !== 'init' || p.method || p.computed) {
            literal = false
            if (p.type === 'Property') {
              visit(p.key)
              visit(p.value)
            } else visit(p.argument)
            continue
          }
          visit(p.key, true)
          if (!p.shorthand) visit(p.value)
          else literal = false
        }
        return
      case 'ArrayExpression':
        for (const el of (node as unknown as { elements: (Node | null)[] }).elements) visit(el)
        return
      case 'Literal': {
        const lit = node as Literal
        if (typeof lit.value === 'string') strings.push(lit.value)
        else if (lit.regex) strings.push(lit.regex.pattern)
        else if (typeof lit.value === 'bigint') literal = false
        return
      }
      case 'Identifier': {
        const name = (node as unknown as { name: string }).name
        strings.push(name)
        if (!asKey && !LITERAL_IDENTIFIERS.has(name)) literal = false
        return
      }
      case 'UnaryExpression': {
        const u = node as unknown as { operator: string; argument: Node }
        if (u.operator !== '-' && u.operator !== '+') literal = false
        visit(u.argument)
        return
      }
      case 'CallExpression':
      case 'NewExpression': {
        const c = node as unknown as { callee: Node; arguments: Node[] }
        const callee = c.callee as unknown as { type: string; name?: string }
        if (callee.type !== 'Identifier' || !BSON_CONSTRUCTORS.has(callee.name ?? ''))
          literal = false
        else strings.push(callee.name!)
        if (callee.type !== 'Identifier') visit(c.callee)
        for (const a of c.arguments) visit(a)
        return
      }
      case 'TemplateLiteral': {
        literal = false
        const t = node as unknown as {
          quasis: { value: { cooked: string | null; raw: string } }[]
          expressions: Node[]
        }
        for (const q of t.quasis) strings.push(q.value.cooked ?? q.value.raw)
        for (const e of t.expressions) visit(e)
        return
      }
      default: {
        // Anything else (binary operators, member access, functions…) is not a plain literal.
        literal = false
        for (const value of Object.values(node as unknown as Record<string, unknown>)) {
          if (Array.isArray(value))
            for (const v of value) {
              if (v && typeof v === 'object' && 'type' in v) visit(v as Node)
            }
          else if (value && typeof value === 'object' && 'type' in value) visit(value as Node)
        }
      }
    }
  }
  visit(root)
  return { literal, strings }
}

/* ---------- call chains ---------- */

type Link =
  | { kind: 'root'; name: string; node: Node }
  | { kind: 'prop'; name: string; node: Node }
  | { kind: 'call'; args: (Expression | SpreadElement)[]; node: CallExpression }

const ONLY_CALLS =
  'Solo se admiten llamadas db.colección.método(...), db.método(...), rs.status(), use <bd> y show dbs|collections.'

function flatten(expr: Node): Link[] {
  switch (expr.type) {
    case 'CallExpression': {
      const call = expr as CallExpression
      if (call.optional)
        throw new MongoShellError('No se admite el encadenamiento opcional (?.).', call.start)
      if (call.callee.type === 'Super') throw new MongoShellError(ONLY_CALLS, call.start)
      return [...flatten(call.callee), { kind: 'call', args: call.arguments, node: call }]
    }
    case 'MemberExpression': {
      const m = expr as MemberExpression
      if (m.optional)
        throw new MongoShellError('No se admite el encadenamiento opcional (?.).', m.start)
      if (m.object.type === 'Super') throw new MongoShellError(ONLY_CALLS, m.start)
      let name: string
      if (!m.computed && m.property.type === 'Identifier') name = m.property.name
      else if (
        m.computed &&
        m.property.type === 'Literal' &&
        typeof (m.property as Literal).value === 'string'
      )
        name = (m.property as Literal).value as string
      else
        throw new MongoShellError(
          "El nombre de la colección debe ser un texto literal: db['mi-colección'].",
          m.property.start
        )
      return [...flatten(m.object), { kind: 'prop', name, node: m.property }]
    }
    case 'Identifier':
      return [{ kind: 'root', name: (expr as unknown as { name: string }).name, node: expr }]
    case 'ChainExpression':
      throw new MongoShellError('No se admite el encadenamiento opcional (?.).', expr.start)
    case 'ParenthesizedExpression':
      return flatten((expr as unknown as { expression: Node }).expression)
    default:
      throw new MongoShellError(ONLY_CALLS, expr.start)
  }
}

function stringArg(link: Link | undefined, what: string, script: string): string {
  if (!link || link.kind !== 'call' || link.args.length !== 1)
    throw new MongoShellError(
      `${what} necesita un único argumento de texto.`,
      link?.node.start ?? 0
    )
  const arg = argOf(link.args[0], script)
  if (arg.kind !== 'string' || !arg.value)
    throw new MongoShellError(`${what} necesita un texto literal no vacío.`, arg.start)
  return arg.value
}

function callArgs(link: Link | undefined, method: string, script: string): MongoArg[] {
  if (!link || link.kind !== 'call')
    throw new MongoShellError(`Falta «(…)» después de ${method}.`, link?.node.start ?? 0)
  return link.args.map((a) => argOf(a, script))
}

/** Pairs `.name(args)` after the method call. */
function chainOf(links: Link[], from: number, script: string): MongoCall[] {
  const chain: MongoCall[] = []
  for (let i = from; i < links.length; i += 2) {
    const prop = links[i]
    const call = links[i + 1]
    if (prop.kind !== 'prop')
      throw new MongoShellError('Llamada inesperada en la cadena de métodos.', prop.node.start)
    if (!call || call.kind !== 'call')
      throw new MongoShellError(`Falta «(…)» después de .${prop.name}.`, prop.node.start)
    chain.push({
      name: prop.name,
      args: call.args.map((a) => argOf(a, script)),
      start: prop.node.start,
      end: call.node.end
    })
  }
  return chain
}

function parseStatement(stmt: ExpressionStatement, script: string): MongoStatement {
  const links = flatten(stmt.expression)
  const base = {
    text: script.slice(stmt.start, stmt.end).replace(/;\s*$/, '').trim(),
    start: stmt.start,
    end: stmt.end
  }
  const root = links[0]
  if (root.kind !== 'root') throw new MongoShellError(ONLY_CALLS, stmt.start)

  if (root.name === 'rs') {
    const prop = links[1]
    if (!prop || prop.kind !== 'prop' || !(RS_METHODS as readonly string[]).includes(prop.name))
      throw new MongoShellError('Solo se admite rs.status().', prop?.node.start ?? root.node.start)
    if (links.length > 3)
      throw new MongoShellError('rs.status() no admite métodos encadenados.', links[3].node.start)
    return { ...base, type: 'rs', method: prop.name, args: callArgs(links[2], 'rs.status', script) }
  }
  if (root.name !== 'db') {
    const hint =
      root.name === 'var' || root.name === 'let' || root.name === 'const'
        ? ' No se admiten variables.'
        : ''
    throw new MongoShellError(ONLY_CALLS + hint, root.node.start)
  }

  let i = 1
  let database: string | null = null
  // db.getSiblingDB('x').…
  if (links[i]?.kind === 'prop' && (links[i] as { name: string }).name === 'getSiblingDB') {
    database = stringArg(links[i + 1], 'getSiblingDB', script)
    i += 2
  }
  const first = links[i]
  if (!first || first.kind !== 'prop') throw new MongoShellError(ONLY_CALLS, stmt.start)

  // db.method(...)
  if (links[i + 1]?.kind === 'call' && first.name !== 'getCollection') {
    if (!DB_METHODS.has(first.name))
      throw new MongoShellError(
        `db.${first.name}() no está entre las órdenes admitidas (${[...DB_METHODS].join(', ')}).`,
        first.node.start
      )
    if (links.length > i + 2)
      throw new MongoShellError(
        `db.${first.name}() no admite métodos encadenados.`,
        links[i + 2].node.start
      )
    return {
      ...base,
      type: 'db',
      database,
      method: first.name,
      args: callArgs(links[i + 1], `db.${first.name}`, script)
    }
  }

  // Collection: db.getCollection('x') | db.a.b.c (dots join the name) | db['x']
  let collection: string
  if (first.name === 'getCollection') {
    collection = stringArg(links[i + 1], 'getCollection', script)
    i += 2
  } else {
    const parts: string[] = []
    while (links[i]?.kind === 'prop' && links[i + 1]?.kind !== 'call') {
      parts.push((links[i] as { name: string }).name)
      i++
    }
    collection = parts.join('.')
  }
  const methodLink = links[i]
  if (!collection || !methodLink || methodLink.kind !== 'prop')
    throw new MongoShellError(
      'Indica la colección y el método: db.colección.find({...}).',
      methodLink?.node.start ?? stmt.start
    )

  let explain: { verbosity: MongoArg | null } | null = null
  let method = methodLink.name
  let args = callArgs(links[i + 1], method, script)
  i += 2
  if (method === 'explain') {
    explain = { verbosity: args[0] ?? null }
    const real = links[i]
    if (!real || real.kind !== 'prop')
      throw new MongoShellError(
        'explain() debe ir seguido del método: db.c.explain().find({...}).',
        methodLink.node.start
      )
    method = real.name
    args = callArgs(links[i + 1], method, script)
    i += 2
  }
  if (!COLLECTION_METHODS.has(method))
    throw new MongoShellError(
      `El método ${method}() no está entre los admitidos. Lectura: ${COLLECTION_READ_METHODS.join(', ')}. Escritura: ${COLLECTION_WRITE_METHODS.join(', ')}.`,
      methodLink.node.start
    )
  const chain = chainOf(links, i, script)
  // Trailing .explain(v)
  const last = chain[chain.length - 1]
  if (last?.name === 'explain') {
    if (explain) throw new MongoShellError('explain() aparece dos veces.', last.start)
    explain = { verbosity: last.args[0] ?? null }
    chain.pop()
  }
  if (explain && !EXPLAINABLE.has(method))
    throw new MongoShellError(`explain() no se admite con ${method}().`, methodLink.node.start)
  for (const link of chain) {
    if (link.name === 'forEach' || link.name === 'map')
      throw new MongoShellError(
        `.${link.name}(…) ejecuta código JavaScript y no se admite: el resultado se muestra en la rejilla.`,
        link.start
      )
    const allowed =
      NOOP_MODIFIERS.has(link.name) ||
      (method === 'find' && (FIND_MODIFIERS.has(link.name) || COUNT_MODIFIERS.has(link.name))) ||
      (method === 'aggregate' && COUNT_MODIFIERS.has(link.name) && link.name !== 'count')
    if (!allowed)
      throw new MongoShellError(`.${link.name}(…) no se admite después de ${method}().`, link.start)
  }
  const countAt = chain.findIndex((c) => COUNT_MODIFIERS.has(c.name))
  if (countAt >= 0 && chain.slice(countAt + 1).some((c) => !NOOP_MODIFIERS.has(c.name)))
    throw new MongoShellError(`.${chain[countAt].name}() debe ir al final.`, chain[countAt].start)
  return { ...base, type: 'collection', database, collection, method, args, chain, explain }
}

/**
 * Parses a script into statements, in source order. Throws MongoShellError
 * (with the offset) for anything outside the grammar: nothing of a script runs
 * unless all of it parses.
 */
export function parseShellScript(script: string): MongoStatement[] {
  const { text, specials } = maskSpecialLines(script)
  let program
  try {
    program = acornParse(text, { ecmaVersion: 'latest', sourceType: 'script' })
  } catch (err) {
    const e = err as { pos?: number; message?: string }
    const where = typeof e.pos === 'number' ? positionText(script, e.pos) : ''
    throw new MongoShellError(
      `Error de sintaxis${where}: ${String(e.message ?? err).replace(/\s*\(\d+:\d+\)$/, '')}`,
      e.pos ?? 0
    )
  }
  const statements: MongoStatement[] = [...specials]
  for (const node of program.body) {
    if (node.type === 'EmptyStatement') continue
    if (node.type === 'VariableDeclaration')
      throw new MongoShellError(
        'No se admiten variables (var, let, const): escribe cada orden como db.colección.método(...).',
        node.start
      )
    if (node.type !== 'ExpressionStatement') throw new MongoShellError(ONLY_CALLS, node.start)
    statements.push(parseStatement(node as ExpressionStatement, script))
  }
  return statements.sort((a, b) => a.start - b.start)
}

/** " (línea L, columna C)" of an offset. */
export function positionText(script: string, offset: number): string {
  const before = script.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - before.lastIndexOf('\n')
  return ` (línea ${line}, columna ${column})`
}

/** The statement under a caret offset (for «Ejecutar actual»), or null. */
export function statementAt(statements: MongoStatement[], offset: number): MongoStatement | null {
  return statements.find((s) => offset >= s.start && offset <= s.end) ?? null
}
