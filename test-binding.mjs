/** Per-conversation agent binding: several sessions may run under different agents. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createStore, MemoryError } = await import(`file://${path.join(here, 'store.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-binding-'))
const store = createStore({ rootDir: path.join(scratch, 'mem'), knowledgeDir: path.join(scratch, 'kb') })

const alpha = store.createAgent({ name: 'Alpha' })
const beta = store.createAgent({ name: 'Beta' })

assert.equal(store.bindingOf('s-1'), '')
store.setBinding({ sessionId: 's-1', agentId: alpha.id })
assert.equal(store.bindingOf('s-1'), alpha.id)
assert.equal(store.resolveVault({ sessionId: 's-1' }).id, alpha.id)

// an explicit id still wins over the binding
assert.equal(store.resolveVault({ sessionId: 's-1', id: beta.id }).id, beta.id)

// unbound session falls back to the configured default
store.saveSettings({ activeVault: beta.id })
assert.equal(store.resolveVault({ sessionId: 's-2' }).id, beta.id)

// two conversations, two agents, at the same time
store.setBinding({ sessionId: 's-2', agentId: beta.id })
assert.equal(store.resolveVault({ sessionId: 's-1' }).id, alpha.id)
assert.equal(store.resolveVault({ sessionId: 's-2' }).id, beta.id)
assert.equal(store.listBindings().length, 2)

// unbinding returns the session to the default
store.setBinding({ sessionId: 's-2', agentId: '' })
assert.equal(store.bindingOf('s-2'), '')
assert.equal(store.resolveVault({ sessionId: 's-2' }).id, beta.id)

// unknown agent rejected, empty session rejected
assert.throws(() => store.setBinding({ sessionId: 's-3', agentId: 'nope' }), (error) => error instanceof MemoryError && error.code === 'no-vault')
assert.throws(() => store.setBinding({ sessionId: '', agentId: alpha.id }), (error) => error instanceof MemoryError && error.code === 'bad-session')

// deleting an agent unbinds its conversations
store.setBinding({ sessionId: 's-9', agentId: alpha.id })
assert.equal(store.listBindings().length, 2)
const removed = store.deleteAgent({ id: alpha.id })
assert.equal(removed.unbound, 2)
assert.equal(store.bindingOf('s-9'), '')
assert.equal(store.listBindings().length, 0)

// state exposes bindings for the panel
assert.ok(Array.isArray(store.state().bindings))

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL BINDING TESTS PASSED')
