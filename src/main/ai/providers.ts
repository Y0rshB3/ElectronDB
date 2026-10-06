import { join } from 'node:path'
import {
  AI_PROVIDER_PRESETS,
  AI_PROVIDER_TYPES,
  type AiProviderInput,
  type AiProviderProfile,
  type AiProviderType
} from '@shared/ai'
import { JsonStore } from '../storage/jsonStore'
import { newId, nowIso } from '../storage/ids'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isProviderType(value: unknown): value is AiProviderType {
  return typeof value === 'string' && (AI_PROVIDER_TYPES as readonly string[]).includes(value)
}

/**
 * Effective base URL of a provider profile. Fixed presets always use their own
 * URL (a stored value cannot redirect the key elsewhere); Ollama and
 * Personalizado use the user's URL. Throws an actionable Spanish message when
 * the URL is not acceptable: https is required, plain http only for
 * localhost / 127.0.0.1 (a local Ollama or compatible server).
 */
export function resolveBaseUrl(type: AiProviderType, url: string): string {
  const preset = AI_PROVIDER_PRESETS[type]
  if (!preset.editableBaseUrl) return preset.baseUrl
  const raw = (url ?? '').trim() || preset.baseUrl
  if (!raw)
    throw new Error('Indica la URL base del proveedor (por ejemplo https://mi-servidor/v1).')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`La URL base «${raw}» no es válida.`)
  }
  if (parsed.username || parsed.password)
    throw new Error('La URL base no puede llevar usuario ni contraseña: usa el campo de la clave.')
  if (parsed.search || parsed.hash)
    throw new Error('La URL base no puede llevar parámetros (?…) ni fragmentos (#…).')
  const local = LOCAL_HOSTS.has(parsed.hostname)
  if (parsed.protocol === 'http:' && !local)
    throw new Error(
      'La URL base debe usar https. Solo se admite http para un servidor local (localhost o 127.0.0.1).'
    )
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('La URL base debe empezar por https:// (o http:// para localhost).')
  return parsed.toString().replace(/\/+$/, '')
}

/** Validates and normalises a profile coming from the renderer. */
export function normalizeProviderInput(input: AiProviderInput): AiProviderInput {
  if (!input || typeof input !== 'object') throw new Error('Datos del proveedor no válidos.')
  if (!isProviderType(input.type)) throw new Error('Tipo de proveedor no válido.')
  const preset = AI_PROVIDER_PRESETS[input.type]
  const name = String(input.name ?? '').trim() || preset.label
  if (name.length > 80) throw new Error('El nombre del proveedor es demasiado largo (máx. 80).')
  const model = String(input.model ?? '').trim() || preset.defaultModel
  if (!model) throw new Error('Indica el modelo que quieres usar.')
  if (model.length > 200 || /\s/.test(model)) throw new Error('El ID del modelo no es válido.')
  return {
    id: typeof input.id === 'string' && input.id ? input.id : undefined,
    name,
    type: input.type,
    baseUrl: resolveBaseUrl(input.type, String(input.baseUrl ?? '')),
    model
  }
}

interface ProvidersDoc {
  version: number
  items: AiProviderProfile[]
}

/** userData/ai-providers.json: provider profiles (no keys). */
export class AiProvidersRepo {
  private store: JsonStore<ProvidersDoc>
  constructor(dir: string) {
    this.store = new JsonStore<ProvidersDoc>(join(dir, 'ai-providers.json'), () => ({
      version: 1,
      items: []
    }))
  }

  list(): AiProviderProfile[] {
    return [...this.store.get().items]
      .filter((p) => isProviderType(p.type))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): AiProviderProfile | null {
    return this.list().find((p) => p.id === id) ?? null
  }

  save(raw: AiProviderInput): AiProviderProfile {
    const input = normalizeProviderInput(raw)
    const existing = input.id ? this.get(input.id) : null
    const now = nowIso()
    const record: AiProviderProfile = {
      id: existing?.id ?? newId(),
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl,
      model: input.model,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    this.store.update((d) => {
      const idx = d.items.findIndex((p) => p.id === record.id)
      if (idx >= 0) d.items[idx] = record
      else d.items.push(record)
    })
    return record
  }

  delete(id: string): void {
    this.store.update((d) => {
      d.items = d.items.filter((p) => p.id !== id)
    })
  }
}
