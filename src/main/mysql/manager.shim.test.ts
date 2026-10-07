import { describe, expect, it } from 'vitest'
import * as dbManager from '../db/manager'
import * as dbTunnel from '../db/tunnel'
import * as driver from './driver'
import * as manager from './manager'
import * as tunnel from './tunnel'

// The old paths re-export the moved modules for one phase (P1a): same objects, not copies.
describe('mysql/manager and mysql/tunnel shims', () => {
  it('re-export the generic connection manager', () => {
    expect(manager.ConnectionManager).toBe(dbManager.ConnectionManager)
    expect(manager.getConnectionManager).toBe(dbManager.getConnectionManager)
    expect(manager.getSessionFactory).toBe(dbManager.getSessionFactory)
    expect(manager.castGeometryAsBuffer).toBe(driver.castGeometryAsBuffer)
  })

  it('re-export the tunnel', () => {
    expect(tunnel.openSshTunnel).toBe(dbTunnel.openSshTunnel)
    expect(tunnel.buildConnectConfig).toBe(dbTunnel.buildConnectConfig)
    expect(tunnel.checkPrivateKey).toBe(dbTunnel.checkPrivateKey)
  })
})
