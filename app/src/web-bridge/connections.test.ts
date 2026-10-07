import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWebBridge } from './bridge'
import { getActiveGateway } from './gateways'

// jsdom serves from http://localhost:3000, so that is the "serving" gateway.
const ORIGIN = window.location.origin

function bridge() {
  return createWebBridge()!
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  delete window.__HERMES_SESSION_TOKEN__
})

describe('web bridge connection registry', () => {
  it('exposes the zero-config default as the active remote source', async () => {
    const registry = await bridge().connections.list()

    expect(registry.connections).toHaveLength(1)
    expect(registry.connections[0]).toMatchObject({ kind: 'remote', url: ORIGIN })
    expect(registry.primary).toBe(registry.connections[0].id)
  })

  it('dials a saved /prefix gateway by id, and rejects unknown ids like Electron', async () => {
    const desktop = bridge()
    const { connection } = await desktop.connections.save({ kind: 'remote', label: 'Work', url: '/hermes', authMode: 'oauth' })

    const descriptor = await desktop.getConnectionFor!({ connectionId: connection.id, profile: 'coder' })

    expect(descriptor).toMatchObject({
      baseUrl: `${ORIGIN}/hermes`,
      connectionId: connection.id,
      profile: 'coder',
      registryScoped: true,
      sharedRemote: true
    })
    await expect(desktop.getConnectionFor!({ connectionId: 'missing' })).rejects.toThrow('No connection with id "missing"')
  })

  it('refuses sources a browser cannot reach', async () => {
    const desktop = bridge()

    await expect(
      desktop.connections.save({ kind: 'remote', label: 'Far', url: 'https://hermes.example.com', authMode: 'oauth' })
    ).rejects.toThrow(/served from this site/)
    await expect(desktop.connections.save({ kind: 'ssh', label: 'Box', host: 'box' })).rejects.toThrow(/desktop app/)
  })

  it('follows the route upstream reports after a switch', async () => {
    const desktop = bridge()
    const { connection } = await desktop.connections.save({ kind: 'remote', label: 'Work', url: '/hermes', authMode: 'oauth' })

    desktop.setActiveConnectionRoute!({ connectionId: connection.id })

    expect(getActiveGateway().id).toBe(connection.id)
    expect((await desktop.getConnection()).baseUrl).toBe(`${ORIGIN}/hermes`)
  })

  it("scopes the served session token to the serving gateway only", async () => {
    window.__HERMES_SESSION_TOKEN__ = 'served-token'
    const desktop = bridge()
    const { connection } = await desktop.connections.save({ kind: 'remote', label: 'Work', url: '/hermes', authMode: 'oauth' })

    expect((await desktop.getConnection()).token).toBe('served-token')
    expect((await desktop.getConnectionFor!({ connectionId: connection.id })).token).toBe('')
  })
})
