import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useConnectionsStore } from '@renderer/stores/connections'
import { nodeIds, useTreeStore } from '@renderer/stores/tree'
import {
  createTestVuetify,
  flush,
  installBridge,
  installDomPolyfills,
  makeConnection,
  makeServerInfo,
  makeTable
} from '@renderer/__tests__/shellTestUtils'
import InfoPanel from './InfoPanel.vue'

function rows(text: string): Record<string, string> {
  return Object.fromEntries(
    [...document.querySelectorAll(`${text} dt`)].map((dt) => [
      dt.textContent!.trim(),
      dt.nextElementSibling!.textContent!.trim()
    ])
  )
}

describe('InfoPanel', () => {
  beforeEach(async () => {
    installDomPolyfills()
    setActivePinia(createPinia())
    installBridge({
      'connections:list': [
        makeConnection({ id: 'c1', name: 'Dev', environment: 'staging', host: 'db.local' })
      ],
      'connections:open': () => makeServerInfo({ version: '8.4.7', characterSet: 'utf8mb4' }),
      'db:databases': () => [{ name: 'shop', characterSet: 'utf8mb4', collation: 'utf8mb4_bin' }],
      'db:tables': () => [makeTable('users', { engine: 'InnoDB' })]
    })
    await useConnectionsStore().load()
    document.body.innerHTML = ''
  })

  it('shows a hint when nothing is selected', () => {
    const wrapper = mount(InfoPanel, { global: { plugins: [createTestVuetify()] } })
    expect(wrapper.text()).toContain('Selecciona una conexión u objeto')
    wrapper.unmount()
  })

  it('shows the selected connection profile', async () => {
    const tree = useTreeStore()
    tree.select(nodeIds.connection('c1'))
    const wrapper = mount(InfoPanel, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    let info = rows('[data-test="info-connection"]')
    expect(info['Host']).toBe('db.local')
    expect(info['Puerto']).toBe('33306')
    expect(info['Nombre de usuario']).toBe('tester')
    expect(info['Versión del servidor']).toBe('Conexión cerrada')
    expect(Object.keys(info)).toEqual(
      expect.arrayContaining(['Perfil activo', 'Codificación', 'Observaciones'])
    )

    await useConnectionsStore().open('c1')
    await flush()
    info = rows('[data-test="info-connection"]')
    expect(info['Versión del servidor']).toContain('8.4.7')
    expect(info['Codificación']).toBe('utf8mb4')
    wrapper.unmount()
  })

  it('shows details of the selected table', async () => {
    const tree = useTreeStore()
    await useConnectionsStore().open('c1')
    await tree.loadGroup('c1', 'shop', 'tables')
    const node = tree.childrenOf(tree.parse(nodeIds.group('c1', 'shop', 'tables'))!)[0]
    tree.select(node.id)
    const wrapper = mount(InfoPanel, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    const section = wrapper.get('[data-test="info-object"]')
    expect(section.text()).toContain('users')
    expect(section.text()).toContain('InnoDB')
    wrapper.unmount()
  })

  it('lists engine details the server reports (PostgreSQL)', async () => {
    installBridge({
      'connections:list': [
        makeConnection({ id: 'pg', name: 'PG', engine: 'postgresql', port: 5432 })
      ],
      'connections:open': () =>
        makeServerInfo({
          version: '17.11',
          engine: 'postgresql',
          details: [
            { label: 'Base de datos inicial', value: 'shop' },
            { label: 'Cifrado', value: 'SSL: TLSv1.3' }
          ]
        })
    })
    const connections = useConnectionsStore()
    await connections.load()
    await connections.open('pg')
    useTreeStore().select(nodeIds.connection('pg'))
    const wrapper = mount(InfoPanel, {
      global: { plugins: [createTestVuetify()] },
      attachTo: document.body
    })
    await flush()
    const info = rows('[data-test="info-connection"]')
    expect(info['Base de datos inicial']).toBe('shop')
    expect(info['Cifrado']).toBe('SSL: TLSv1.3')
    wrapper.unmount()
  })
})
