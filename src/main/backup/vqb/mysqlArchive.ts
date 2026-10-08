import type { Nb3Manifest, Nb3ObjectMeta } from '../nb3/format'
import type { RestoreArchive } from '../archive'
import { engineMismatchMessage } from './engine'
import type { VqbObjectMeta, VqbObjectType } from './format'
import { mysqlTuple } from './mysqlValues'
import { VqbReader } from './reader'

/**
 * A MySQL/MariaDB .vqb seen through the shape restore.ts walks (the one the
 * .nb3 reader produces): same objects, DDL, triggers and AUTO_INCREMENT, and
 * each row rendered as a MySQL tuple from its typed values. Restores and
 * REPLACE restores of both formats therefore share one code path.
 */

export const NB3_TYPE_OF: Record<VqbObjectType, string> = {
  table: 'Table',
  view: 'View',
  materialized_view: 'MaterializedView',
  function: 'Function',
  procedure: 'Procedure',
  event: 'Event',
  type: 'Type',
  sequence: 'Sequence',
  extension: 'Extension',
  collection: 'Collection'
}

export class VqbMysqlArchive implements RestoreArchive {
  readonly format = 'vqb' as const
  private readonly metas = new Map<string, VqbObjectMeta>()
  private readonly ids = new WeakMap<Nb3ObjectMeta, string>()

  private constructor(
    private readonly reader: VqbReader,
    private readonly shaped: Nb3Manifest,
    readonly timeZone: string | null
  ) {}

  static async open(path: string, password?: string | null): Promise<VqbMysqlArchive> {
    const reader = await VqbReader.open(path, password)
    try {
      await reader.unlock(password)
      const m = await reader.manifest()
      if (m.engine.id !== 'mysql') throw new Error(engineMismatchMessage(m.engine.id, 'mysql'))
      const shaped: Nb3Manifest = {
        MetaVersion: `vqb-${m.formatVersion}`,
        DatabaseType: 'MYSQL',
        ServiceProvider: '',
        Catalog: '',
        Schema: m.source.database,
        StartTime: m.createdAt,
        EndTime: m.finishedAt,
        Encryption: 'None',
        Comment: m.comment ?? '',
        Objects: m.objects.map((o) => ({
          UUID: o.id,
          Type: NB3_TYPE_OF[o.type] ?? o.type,
          Name: o.name,
          Rows: o.rows === null ? '' : String(o.rows),
          Metadata: { Filename: `objects/${o.id}/meta.json`, Checksum: '' }
        }))
      }
      return new VqbMysqlArchive(reader, shaped, m.source.timeZone ?? null)
    } catch (err) {
      await reader.close()
      throw err
    }
  }

  async manifest(): Promise<Nb3Manifest> {
    return this.shaped
  }

  async objectMeta(uuid: string): Promise<Nb3ObjectMeta> {
    const meta = await this.reader.objectMeta(uuid)
    this.metas.set(uuid, meta)
    const shaped: Nb3ObjectMeta = {
      MetaVersion: this.shaped.MetaVersion,
      Name: meta.name,
      Type: NB3_TYPE_OF[meta.type] ?? meta.type,
      DDL: await this.reader.ddl(meta),
      SubDDL: meta.postDdl ?? [],
      AutoIncrement: meta.autoIncrement ?? '',
      Fields: (meta.columns ?? []).map((c) => c.name),
      TriggerDDL: meta.triggers ?? [],
      IndexDDL: meta.indexes ?? [],
      Data: (meta.data ?? []).map((d) => ({ Filename: d.path, Checksum: '' }))
    }
    this.ids.set(shaped, uuid)
    return shaped
  }

  async rows(
    meta: Nb3ObjectMeta,
    onRow: (tuple: string) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<number> {
    const id = this.ids.get(meta)
    const source = id ? this.metas.get(id) : undefined
    if (!source) throw new Error(`Faltan los metadatos de ${meta.Name} en la copia`)
    return this.reader.rows(source, (row) => onRow(mysqlTuple(row)), signal)
  }

  async close(): Promise<void> {
    await this.reader.close()
  }
}
