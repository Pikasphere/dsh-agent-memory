/** Discussion rooms: shared transcript, late join, membership changes. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createRooms } = await import(`file://${path.join(here, 'rooms.js').replace(/\\/g, '/')}`)
const { MemoryError } = await import(`file://${path.join(here, 'store.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-rooms-'))
const rooms = createRooms({ rootDir: path.join(scratch, 'mem') })

const room = rooms.create({ name: '架构评审' })
assert.match(room.id, /^r-[a-z0-9]{4,12}$/)
assert.equal(rooms.list().length, 1)

// two agents join, a third joins late
rooms.join({ id: room.id, member: 'alpha' })
rooms.join({ id: room.id, member: 'beta' })
assert.deepEqual(rooms.requireRoom(room.id).members, ['alpha', 'beta'])
rooms.join({ id: room.id, member: 'gamma' })
assert.equal(rooms.requireRoom(room.id).members.length, 3)

// speaking keeps the speaker
rooms.say({ id: room.id, text: '先看存储层', from: { kind: 'agent', id: 'alpha', name: 'Alpha' } })
rooms.say({ id: room.id, text: '我同意', from: { kind: 'agent', id: 'beta', name: 'Beta' } })
rooms.say({ id: room.id, text: '补一点', from: { kind: 'user', id: 'user', name: '我' } })

const transcript = rooms.read({ id: room.id })
assert.equal(transcript.total, 3)
assert.deepEqual(transcript.messages.map(m => m.from.id), ['alpha', 'beta', 'user'])
assert.equal(transcript.messages[0].text, '先看存储层')

// limit takes the tail
const tail = rooms.read({ id: room.id, limit: 2 })
assert.deepEqual(tail.messages.map(m => m.from.id), ['beta', 'user'])

// leaving does not erase history
rooms.leave({ id: room.id, member: 'alpha' })
assert.deepEqual(rooms.requireRoom(room.id).members, ['beta', 'gamma'])
assert.equal(rooms.read({ id: room.id }).total, 3)

// several rooms at once
const second = rooms.create({ name: '二室' })
assert.equal(rooms.list().length, 2)
assert.notEqual(second.id, room.id)

// rename, clear, remove
rooms.rename({ id: room.id, name: '架构评审 v2' })
assert.equal(rooms.requireRoom(room.id).name, '架构评审 v2')
rooms.clear({ id: room.id })
assert.equal(rooms.read({ id: room.id }).total, 0)
rooms.remove({ id: room.id })
assert.equal(rooms.list().length, 1)

// unknown room is a typed failure, not a crash
assert.throws(
  () => rooms.read({ id: 'r-zzzz' }),
  error => error instanceof MemoryError && error.code === 'no-room',
)
assert.throws(
  () => rooms.read({ id: '../../etc' }),
  error => error instanceof MemoryError && error.code === 'bad-room',
)

fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL ROOM TESTS PASSED')
