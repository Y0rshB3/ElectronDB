import { describe, expect, it } from 'vitest'
import { MongoShellError, parseShellScript, type MongoStatement } from './shell'
import {
  analyzeMongoWrites,
  isObviousMongoWrite,
  statementIsObviousWrite,
  statementIsRead,
  valueHasWriteStage
} from './classify'

function one(script: string): MongoStatement {
  const all = parseShellScript(script)
  expect(all).toHaveLength(1)
  return all[0]
}

function refused(script: string): MongoShellError {
  try {
    parseShellScript(script)
  } catch (err) {
    expect(err).toBeInstanceOf(MongoShellError)
    return err as MongoShellError
  }
  throw new Error(`accepted: ${script}`)
}

describe('parseShellScript: grammar', () => {
  it('reads a find with modifiers', () => {
    const s = one("db.orders.find({ status: 'A' }, { _id: 0 }).sort({ at: -1 }).limit(10)")
    expect(s).toMatchObject({ type: 'collection', collection: 'orders', method: 'find' })
    if (s.type !== 'collection') throw new Error()
    expect(s.args.map((a) => a.kind)).toEqual(['expr', 'expr'])
    expect(s.chain.map((c) => c.name)).toEqual(['sort', 'limit'])
    expect(s.chain[1].args[0]).toMatchObject({ kind: 'number', value: 10 })
  })

  it('accepts getCollection, bracket names and dotted names', () => {
    expect(one("db.getCollection('my-coll').find()")).toMatchObject({ collection: 'my-coll' })
    expect(one("db['a b'].countDocuments({})")).toMatchObject({ collection: 'a b' })
    expect(one('db.system.profile.find()')).toMatchObject({ collection: 'system.profile' })
    expect(one('db.stats.find()')).toMatchObject({ type: 'collection', collection: 'stats' })
    expect(one("db.getSiblingDB('other').users.findOne()")).toMatchObject({
      database: 'other',
      collection: 'users'
    })
  })

  it('reads db methods, rs.status, use and show', () => {
    const all = parseShellScript(
      'use shop\nshow collections\ndb.stats()\nrs.status()\nshow dbs;\ndb.getCollectionNames()'
    )
    expect(all.map((s) => s.type)).toEqual(['use', 'show', 'db', 'rs', 'show', 'db'])
    expect(all[0]).toMatchObject({ database: 'shop' })
    expect(all[1]).toMatchObject({ what: 'collections' })
    expect(all[4]).toMatchObject({ what: 'dbs' })
  })

  it('ignores use/show lines inside comments and strings', () => {
    const all = parseShellScript(
      '/*\nuse staging\nshow dbs\n*/\ndb.c.find({ note: `\nuse other\n` })\nuse real'
    )
    expect(all.map((s) => s.type)).toEqual(['collection', 'use'])
    expect(all[1]).toMatchObject({ database: 'real' })
  })

  it('keeps statement order and offsets', () => {
    const script = 'db.a.find()\nuse x\ndb.b.find({ n: 1 });'
    const all = parseShellScript(script)
    expect(all.map((s) => s.text)).toEqual(['db.a.find()', 'use x', 'db.b.find({ n: 1 })'])
    for (const s of all) expect(script.slice(s.start, s.start + s.text.length)).toBe(s.text)
  })

  it('tolerates pasted mongosh snippets', () => {
    expect(one('db.c.find().pretty()')).toMatchObject({ method: 'find' })
    expect(one('db.c.find({}).toArray()')).toMatchObject({ method: 'find' })
    expect(one('db.c.find({a: 1}).count()')).toMatchObject({ method: 'find' })
    expect(one('db.c.aggregate([]).itcount()')).toMatchObject({ method: 'aggregate' })
    const s = one("db.c.explain('executionStats').find({ a: 1 })")
    expect(s).toMatchObject({ method: 'find', explain: { verbosity: { kind: 'string' } } })
    expect(one('db.c.find().explain()')).toMatchObject({
      method: 'find',
      explain: { verbosity: null }
    })
    // Comments are allowed anywhere.
    expect(one('// all of them\ndb.c.find({ /* none */ })')).toMatchObject({ method: 'find' })
  })

  it('refuses anything outside the grammar, with a position', () => {
    for (const script of [
      'process.exit()',
      '(function () { return 1 })()',
      'Math.floor(1.5)',
      'require("fs")',
      'db.c.find().forEach(d => print(d))',
      'var x = db.c.find()',
      'const y = 1',
      'db.runCommand({ drop: "c" })',
      'db.adminCommand({ shutdown: 1 })',
      'db.c.mapReduce(function(){}, function(){})',
      'db.c.find().then(x => x)',
      'db[name].find()',
      'db.c?.find()',
      'if (true) db.c.drop()',
      'db.eval("1")',
      'db.c.find().sort({}).count().limit(1)',
      'db.c.insertOne({}).limit(1)',
      'db.c.find`x`',
      'x = db.c.drop()',
      'db.c.explain().insertOne({})',
      ''
    ]) {
      if (script === '') {
        expect(parseShellScript(script)).toEqual([])
        continue
      }
      const err = refused(script)
      expect(err.position).toBeGreaterThanOrEqual(0)
      expect(err.message).toMatch(/[a-záéíóúñ]/i)
    }
  })

  it('reports syntax errors with line and column', () => {
    const err = refused('db.c.find(\n  { a: 1 \n')
    expect(err.message).toMatch(/Error de sintaxis \(línea \d+, columna \d+\)/)
  })

  it('marks literal arguments and collects decoded keys', () => {
    const s = one(
      "db.c.aggregate([{ $match: { at: { $gt: ISODate('2020-01-01') } } }, { '\\u0024out': 'x' }])"
    )
    if (s.type !== 'collection' || s.args[0].kind !== 'expr') throw new Error()
    expect(s.args[0].literal).toBe(true)
    expect(s.args[0].strings).toContain('$out')
    const t = one('db.c.aggregate([{ $match: { a: 1 + 2 } }])')
    if (t.type !== 'collection' || t.args[0].kind !== 'expr') throw new Error()
    expect(t.args[0].literal).toBe(false)
  })
})

/* ---------- production guard ---------- */

const READS = [
  'db.c.find()',
  "db.c.find({ name: /ab/i, _id: ObjectId('6ac6f781fc637c60b5590643') }).sort({ a: 1 }).skip(5).limit(10)",
  'db.c.findOne({})',
  'db.c.countDocuments({ a: { $gte: 2 } })',
  'db.c.estimatedDocumentCount()',
  "db.c.distinct('city', { active: true })",
  'db.c.getIndexes()',
  'db.c.stats()',
  'db.c.aggregate([{ $match: { a: 1 } }, { $group: { _id: "$k", n: { $sum: 1 } } }])',
  "db.c.aggregate([{ $lookup: { from: 'o', localField: 'a', foreignField: 'b', as: 'out' } }])",
  "db.c.explain('executionStats').aggregate([{ $sort: { a: -1 } }])",
  'db.stats()',
  'db.version()',
  'db.getCollectionNames()',
  'db.serverStatus()',
  'db.currentOp()',
  'rs.status()',
  'use other',
  'show dbs',
  'show collections',
  "db.c.find({ $where: 'this.a > 1' })",
  'db.c.find({ outcome: 1 })',
  "db.c.aggregate([{ $project: { outcome: '$outcome', merged: 1 } }])"
]

const WRITES = [
  'db.c.insertOne({ a: 1 })',
  'db.c.insertMany([{ a: 1 }, { a: 2 }])',
  'db.c.updateOne({ _id: 1 }, { $set: { a: 2 } })',
  'db.c.updateMany({}, { $inc: { n: 1 } })',
  'db.c.replaceOne({ _id: 1 }, { a: 1 })',
  'db.c.deleteOne({ _id: 1 })',
  'db.c.deleteMany({})',
  'db.c.findOneAndUpdate({ _id: 1 }, { $set: { a: 1 } })',
  'db.c.findOneAndReplace({ _id: 1 }, { a: 1 })',
  'db.c.findOneAndDelete({ _id: 1 })',
  'db.c.bulkWrite([{ insertOne: { document: { a: 1 } } }])',
  'db.c.createIndex({ a: 1 })',
  "db.c.dropIndex('a_1')",
  'db.c.dropIndexes()',
  'db.c.drop()',
  "db.c.renameCollection('d')",
  "db.createCollection('d')",
  'db.dropDatabase()',
  "db.c.aggregate([{ $match: {} }, { $out: 'copy' }])",
  "db.c.aggregate([{ $merge: { into: 'copy' } }])",
  "db.c.aggregate([{ '$out': 'copy' }])",
  "db.c.aggregate([{ '\\u0024merge': { into: 'x' } }])",
  "db.c.aggregate([{ \\u0024out: 'x' }])",
  "db.c.explain().aggregate([{ $out: 'x' }])",
  "db.c.find()\ndb.c.aggregate([{ $out: 'x' }])"
]

/** Reads for main (not obvious writes) that the renderer still asks about. */
const RENDERER_ONLY = [
  "db.c.aggregate([{ ['$o' + 'ut']: 'x' }])",
  'db.c.aggregate([{ $match: { a: 1 + 1 } }])',
  'db.c.aggregate([{ ...stage }])',
  'db.c.aggregate(`[{ $out: "x" }]`)',
  "db.c.aggregate([{ $match: { a: 1 } }], { comment: 'x' + 'y' })"
]

describe('production guard classification', () => {
  it('treats read methods and read-only commands as reads (both sides)', () => {
    for (const script of READS) {
      expect(analyzeMongoWrites(script), script).toMatchObject({ writes: false, error: null })
      expect(isObviousMongoWrite(script), script).toBe(false)
    }
  })

  it('treats every write method and $out/$merge as writes (both sides)', () => {
    for (const script of WRITES) {
      const analysis = analyzeMongoWrites(script)
      expect(analysis.writes, script).toBe(true)
      expect(analysis.reasons.length, script).toBeGreaterThan(0)
      expect(isObviousMongoWrite(script), script).toBe(true)
    }
  })

  it('makes the renderer ask about aggregates it cannot prove read-only', () => {
    for (const script of RENDERER_ONLY) {
      const analysis = analyzeMongoWrites(script)
      expect(analysis.writes, script).toBe(true)
    }
  })

  it('gives specific Spanish reasons', () => {
    expect(analyzeMongoWrites('db.c.deleteMany({})').reasons[0]).toMatch(/sin filtro borra todos/)
    expect(analyzeMongoWrites("db.c.aggregate([{ $out: 'x' }])").reasons[0]).toMatch(
      /\$out o \$merge/
    )
    expect(analyzeMongoWrites('db.c.drop()').reasons[0]).toMatch(/elimina la colección «c»/)
  })

  it('isObviousWrite ⇒ analyzeWrites.writes over the corpus', () => {
    for (const script of [...READS, ...WRITES, ...RENDERER_ONLY]) {
      if (isObviousMongoWrite(script)) expect(analyzeMongoWrites(script).writes, script).toBe(true)
    }
  })

  it('holds the implication on generated scripts', () => {
    // Deterministic pseudo-random combinations of methods, stages and key spellings.
    let seed = 42
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const methods = [
      'find',
      'aggregate',
      'countDocuments',
      'distinct',
      'insertOne',
      'deleteMany',
      'updateOne',
      'explain().aggregate',
      'explain().find'
    ]
    const keys = ['$match', '$out', '$merge', "'$out'", "'\\u0024merge'", 'out', 'merge', '$group']
    const values = ['1', "'x'", '{}', '[]', 'ObjectId()', '1 + 1', "'$out'", 'NumberLong(5)']
    for (let n = 0; n < 2000; n++) {
      const stages = Array.from(
        { length: 1 + rand(3) },
        () => `{ ${keys[rand(keys.length)]}: ${values[rand(values.length)]} }`
      )
      const script = `db.c.${methods[rand(methods.length)]}([${stages.join(', ')}])`
      let statements: MongoStatement[]
      try {
        statements = parseShellScript(script)
      } catch {
        continue
      }
      for (const s of statements) {
        if (statementIsObviousWrite(s)) expect(statementIsRead(s), script).toBe(false)
      }
      if (isObviousMongoWrite(script)) expect(analyzeMongoWrites(script).writes, script).toBe(true)
    }
  })

  it('finds write stages in parsed values at any depth', () => {
    expect(valueHasWriteStage([{ $match: {} }, { $out: 'x' }])).toBe(true)
    expect(valueHasWriteStage([{ $facet: { a: [{ $merge: { into: 'x' } }] } }])).toBe(true)
    expect(valueHasWriteStage([{ $match: { a: '$out' } }])).toBe(false)
    expect(valueHasWriteStage([{ $match: { b: new Uint8Array(4) } }])).toBe(false)
  })

  it('reports a parse error instead of a classification', () => {
    expect(analyzeMongoWrites('db.runCommand({})')).toMatchObject({ writes: false })
    expect(analyzeMongoWrites('db.runCommand({})').error).toMatch(/runCommand|admitidas/)
    expect(isObviousMongoWrite('db.runCommand({ drop: 1 })')).toBe(false)
  })
})
