/** One-time fold of the old per-agent knowledge folders into the shared root. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createStore } = await import(`file://${path.join(here, 'store.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-migrate-'))
const knowledgeDir = path.join(scratch, 'kb')
const store = createStore({ rootDir: path.join(scratch, 'mem'), knowledgeDir })

const legacy = store.createAgent({ name: 'Legacy' })
const other = store.createAgent({ name: 'Other' })

// old layout: <kb>/<agentId>/<entry>.md
fs.mkdirSync(path.join(knowledgeDir, legacy.id), { recursive: true })
fs.writeFileSync(
  path.join(knowledgeDir, legacy.id, 'old-note.md'),
  '---\ntitle: Old note\ntags: x\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nsource: \n---\nlegacy body\n',
  'utf8',
)
// an unrelated folder must be left alone
fs.mkdirSync(path.join(knowledgeDir, 'not-an-agent'), { recursive: true })
fs.writeFileSync(path.join(knowledgeDir, 'not-an-agent', 'keep.md'), 'x', 'utf8')

const state = store.state()
assert.equal(fs.existsSync(path.join(knowledgeDir, 'old-note.md')), true, 'entry moved to the shared root')
assert.equal(fs.existsSync(path.join(knowledgeDir, legacy.id)), false, 'empty agent folder removed')
assert.equal(fs.existsSync(path.join(knowledgeDir, 'not-an-agent', 'keep.md')), true, 'unrelated folder untouched')
assert.equal(state.knowledgeCount, 1)

const entry = store.readKnowledge({ entry: 'old-note' })
assert.equal(entry.agent, legacy.id, 'contributor recorded from the old folder')
assert.equal(entry.content.trim(), 'legacy body')

// a different agent reads and writes the same library
const seen = store.searchKnowledge({ query: 'legacy' })
assert.equal(seen.entries.length, 1)
assert.equal(seen.entries[0].agent, legacy.id)
store.saveKnowledge({ id: other.id, title: 'From other', content: 'shared write' })
assert.equal(store.listKnowledge({}).total, 2)
assert.equal(store.listKnowledge({ id: other.id }).entries.length, 1)
assert.equal(store.state().vaults.find(item => item.id === other.id).knowledgeCount, 1)

// memory limit is configurable and defaults higher than the old 800
assert.equal(store.memoryLimit, 4000)
store.writeMemory({ id: legacy.id, content: 'y'.repeat(3000) })
assert.equal(store.state().vaults.find(item => item.id === legacy.id).memoryChars, 3000)

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL MIGRATION TESTS PASSED')
