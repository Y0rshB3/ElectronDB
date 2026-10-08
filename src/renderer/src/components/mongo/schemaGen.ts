/**
 * «Generar esquema» of the collection designer (docs/multi-engine-design.md,
 * 9.5): a `$jsonSchema` proposal from the sampled field shape (names, BSON
 * types and how many documents have each field; never values). The user
 * reviews and edits it before saving.
 */
import type { MongoFieldStat } from '@shared/types'
import { formatKey, quote } from '@shared/mongo/shellFormat'

interface Node {
  types: string[]
  required: boolean
  children: Map<string, Node>
}

const JSON_SCHEMA_TYPES = new Set([
  'double',
  'string',
  'object',
  'array',
  'binData',
  'objectId',
  'bool',
  'date',
  'null',
  'regex',
  'javascript',
  'int',
  'timestamp',
  'long',
  'decimal',
  'minKey',
  'maxKey'
])

function build(fields: MongoFieldStat[]): Map<string, Node> {
  const root = new Map<string, Node>()
  const total = Math.max(0, ...fields.filter((f) => !f.path.includes('.')).map((f) => f.count))
  const parentCount = new Map<string, number>()
  for (const f of fields) parentCount.set(f.path, f.count)
  for (const f of [...fields].sort((a, b) => a.path.split('.').length - b.path.split('.').length)) {
    const parts = f.path.split('.')
    let level = root
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = level.get(parts[i])
      if (!parent) {
        level = new Map()
        break
      }
      level = parent.children
    }
    const parentPath = parts.slice(0, -1).join('.')
    const of = parts.length === 1 ? total : (parentCount.get(parentPath) ?? 0)
    level.set(parts[parts.length - 1], {
      types: Object.keys(f.types).filter((t) => JSON_SCHEMA_TYPES.has(t)),
      required: of > 0 && f.count >= of,
      children: new Map()
    })
  }
  return root
}

function render(nodes: Map<string, Node>, depth: number): string {
  const pad = '  '.repeat(depth)
  const entries = [...nodes.entries()].filter(([k]) => k !== '_id' || depth > 2)
  const props = entries.map(([key, node]) => {
    const types =
      node.types.length === 1 ? quote(node.types[0]) : `[${node.types.map(quote).join(', ')}]`
    const lines = [`${pad}    bsonType: ${types}`]
    if (node.children.size && node.types.includes('object')) {
      lines.push(...objectBody(node.children, depth + 2))
    }
    return `${pad}  ${formatKey(key)}: {\n${lines.join(',\n')}\n${pad}  }`
  })
  return props.join(',\n')
}

function objectBody(nodes: Map<string, Node>, depth: number): string[] {
  const pad = '  '.repeat(depth)
  const required = [...nodes.entries()]
    .filter(([k, n]) => n.required && k !== '_id')
    .map(([k]) => quote(k))
  const out: string[] = []
  if (required.length) out.push(`${pad}required: [${required.join(', ')}]`)
  out.push(`${pad}properties: {\n${render(nodes, depth)}\n${pad}}`)
  return out
}

/** Shell text of `{ $jsonSchema: { … } }` for the sampled fields. */
export function jsonSchemaFrom(fields: MongoFieldStat[]): string {
  const nodes = build(fields)
  if (!nodes.size) return "{\n  $jsonSchema: {\n    bsonType: 'object'\n  }\n}"
  return `{\n  $jsonSchema: {\n    bsonType: 'object',\n${objectBody(nodes, 2).join(',\n')}\n  }\n}`
}
