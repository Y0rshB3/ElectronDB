import type { AiTestResult } from '@shared/ai'
import type { AdapterCallbacks, AdapterRequest, AdapterResult, ChatAdapter } from './adapter'

/**
 * VORTAQ_AI_FIXTURE=1 (screenshots and manual checks only, honoured only
 * with a scratch profile VORTAQ_USER_DATA): a fake provider that streams
 * canned Spanish answers and never touches the network.
 */

const SQL_ANSWER = [
  'Para ver los clientes con más pedidos pagados en los últimos 30 días puedes usar:',
  '',
  '```sql',
  'SELECT c.id, c.name, COUNT(o.id) AS pedidos, SUM(o.total) AS importe',
  '  FROM shot_customers c',
  '  JOIN shot_orders o ON o.customer_id = c.id',
  " WHERE o.status = 'paid'",
  '   AND o.created_at >= NOW() - INTERVAL 30 DAY',
  ' GROUP BY c.id, c.name',
  ' ORDER BY importe DESC',
  ' LIMIT 10;',
  '```',
  '',
  'La unión usa la clave foránea `fk_shot_orders_customer` y el índice `idx_shot_orders_created` filtra por fecha. Revisa el resultado antes de usarlo en un informe.'
].join('\n')

const GENERATE_ANSWER = [
  '```sql',
  'SELECT o.id, c.name, o.total, o.created_at',
  '  FROM shot_orders o',
  '  JOIN shot_customers c ON c.id = o.customer_id',
  " WHERE o.status = 'pending'",
  ' ORDER BY o.created_at DESC',
  ' LIMIT 50;',
  '```',
  'Pedidos pendientes más recientes con el nombre del cliente.'
].join('\n')

const EXPLAIN_ANSWER = [
  '**Qué hace:** une `shot_orders` con `shot_customers` por la clave foránea y agrupa por cliente.',
  '',
  '**Plan:** `shot_orders` se recorre por el índice `idx_shot_orders_created` (rango de fechas) y cada pedido busca su cliente por la clave primaria (`eq_ref`).',
  '',
  '**Sugerencias:**',
  '- Un índice compuesto `(status, created_at)` evitaría filtrar `status` fila a fila:',
  '',
  '```sql',
  'ALTER TABLE shot_orders ADD INDEX idx_shot_orders_status_created (status, created_at);',
  '```',
  '- Selecciona solo las columnas que necesitas en lugar de `*`.'
].join('\n')

const ERROR_ANSWER = [
  'La columna `customer` no existe en `shot_orders`: la clave foránea se llama `customer_id`.',
  '',
  '```sql',
  'SELECT id, customer_id, total FROM shot_orders WHERE customer_id = 3;',
  '```'
].join('\n')

function answerFor(request: AdapterRequest): string {
  const text = request.userMessage
  if (text.startsWith('Task: write ONE')) return GENERATE_ANSWER
  if (text.startsWith('Task: explain what')) return EXPLAIN_ANSWER
  if (text.startsWith('Task: the statement below failed')) return ERROR_ANSWER
  return SQL_ANSWER
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })

export class FixtureAdapter implements ChatAdapter {
  constructor(private readonly delayMs = 12) {}

  async chat(request: AdapterRequest, callbacks: AdapterCallbacks): Promise<AdapterResult> {
    const answer = answerFor(request)
    const chunks = answer.match(/[\s\S]{1,24}/g) ?? []
    try {
      for (const chunk of chunks) {
        await sleep(this.delayMs, request.signal)
        callbacks.onText(chunk)
      }
    } catch {
      return { stopReason: 'cancelled' }
    }
    return {
      stopReason: 'end_turn',
      model: request.model,
      usage: {
        inputTokens: 412 + request.userMessage.length,
        outputTokens: Math.ceil(answer.length / 4),
        cacheReadTokens: Math.ceil(request.context.length / 4),
        cacheWriteTokens: 0
      }
    }
  }

  async test(model: string): Promise<AiTestResult> {
    return { ok: true, message: `Conexión correcta: ${model} disponible (proveedor de prueba).` }
  }

  async listModels(): Promise<string[]> {
    return ['fixture-model']
  }
}
