/**
 * Offline harness: load the Host half with a mock Cordis context and exercise
 * registration plus the HTTP surface, without touching the installed profile.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, name).replace(/\\/g, '/')}`)

const { apply } = await load('index.js')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-host-'))
const registered = { tools: [], sections: [], contexts: [], routes: [], effects: [], handlers: [] }

function scope(deps) {
  return {
    effect(fn, label) {
      const disposer = fn()
      registered.effects.push({ label, disposer })
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        registered.sections.push(section)
        return () => {}
      },
      context(entry) {
        registered.contexts.push(entry)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        registered.routes.push(route)
        return () => {}
      },
    },
  }
}

const ctx = {
  effect(fn, label) {
    return scope([]).effect(fn, label)
  },
  inject(deps, callback) {
    callback(scope(deps))
  },
  get() {
    return undefined
  },
  on(event, handler) {
    registered.handlers.push({ event, handler })
    return () => {}
  },
}

apply(ctx, { memoryDir: path.join(scratch, 'mem'), knowledgeDir: path.join(scratch, 'kb') })

// ── registration ────────────────────────────────────────────────────────────
const names = registered.tools.map(tool => tool.name).sort()
assert.deepEqual(names, [
  'agent_journal',
  'agent_knowledge_read',
  'agent_knowledge_search',
  'agent_knowledge_write',
  'agent_memory_save',
  'agent_room',
])
for (const tool of registered.tools) {
  assert.equal(typeof tool.description, 'string')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.ok(tool.output.render({}, { ok: true })[0].text.includes('ok'))
}
assert.equal(registered.sections.length, 1)
assert.equal(registered.routes.length, 1)
assert.equal(registered.routes[0].path, '/api/agent-memory')
assert.equal(registered.routes[0].kind, 'prefix')
console.log('registration ok:', names.join(', '))

// ── prompt section ──────────────────────────────────────────────────────────
const section = registered.sections[0]
const emptyPrompt = section.text()
assert.ok(emptyPrompt.includes('agent_knowledge_search'))
assert.ok(emptyPrompt.includes('No agent is selected'))
console.log('prompt (no selection) ok')

// ── HTTP surface ────────────────────────────────────────────────────────────
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:64267' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
    },
    end(body) {
      out.body = body ?? ''
    },
  }
}

async function call(method, route, body) {
  const res = fakeRes()
  await registered.routes[0].handler(fakeReq(method, `/api/agent-memory${route}`, body), res)
  const payload = res.out.body === '' ? undefined : JSON.parse(res.out.body)
  return { status: res.out.status, payload }
}

const initial = await call('GET', '/state')
assert.equal(initial.status, 200)
assert.equal(initial.payload.state.vaults.length, 0)
console.log('GET /state ok')

const created = await call('POST', '/op', { op: 'vault.create', args: { name: '重构助手' } })
assert.equal(created.status, 200)
const id = created.payload.value.id
assert.match(id, /^agent-[a-z0-9]+$/)
assert.equal(created.payload.state.vaults.length, 1)
assert.equal(created.payload.state.vaults[0].name, '重构助手')
console.log('vault.create ok', id)

const saved = await call('POST', '/op', { op: 'memory.save', args: { id, content: '目标：拆分存储层。已完成：记忆。下一步：界面。' } })
assert.equal(saved.status, 200)
assert.ok(saved.payload.state.vaults[0].memoryChars > 0)

await call('POST', '/op', { op: 'vault.activate', args: { id } })
const active = (await call('GET', '/state')).payload.state
assert.equal(active.activeVault, id)
const prompt = section.text()
assert.ok(prompt.includes('重构助手'))
assert.ok(prompt.includes('拆分存储层'))
assert.ok(prompt.includes('<agent_memory'))
console.log('memory + prompt injection ok')

const written = await call('POST', '/op', {
  op: 'knowledge.save',
  args: { id, title: '沙箱 ACL', content: '先授予目录遍历权限。', tags: 'acl,windows' },
})
assert.equal(written.status, 200)
const entry = written.payload.value.entry

const searched = await call('POST', '/op', { op: 'knowledge.search', args: { id, query: 'acl' } })
assert.equal(searched.payload.value.entries.length, 1)
const read = await call('POST', '/op', { op: 'knowledge.read', args: { id, entry } })
assert.ok(read.payload.value.content.includes('目录遍历'))
console.log('knowledge save/search/read ok')

// the library is shared: a second agent sees the first agent's entry
const second = await call('POST', '/op', { op: 'vault.create', args: { name: 'Second agent' } })
const secondId = second.payload.value.id
const seenByOther = await call('POST', '/op', { op: 'knowledge.read', args: { entry } })
assert.equal(seenByOther.payload.value.agent, id)
const contributed = await call('POST', '/op', {
  op: 'knowledge.save',
  args: { id: secondId, title: '来自第二个智能体', content: '共享库测试。' },
})
assert.equal(contributed.payload.value.agent, secondId)
const all = await call('POST', '/op', { op: 'knowledge.list', args: {} })
assert.ok(all.payload.value.total >= 2)
console.log('shared knowledge ok')

// ── tools against the same store ────────────────────────────────────────────
const exec = { agent: { id: 'session-test-1234' } }
const memoryTool = registered.tools.find(tool => tool.name === 'agent_memory_save')
const memoryResult = await memoryTool.execute({ content: '交接：界面待验证。' }, exec)
assert.equal(memoryResult.ok, true)
assert.equal(memoryResult.id, id)
assert.ok(memoryResult.chars > 0)

const tooLong = await memoryTool.execute({ content: 'x'.repeat(4200) }, exec)
assert.equal(tooLong.ok, false)
assert.equal(tooLong.error, 'memory-too-long')

const kbTool = registered.tools.find(tool => tool.name === 'agent_knowledge_write')
const kbResult = await kbTool.execute({ title: '打包', content: 'local dir 安装是链接。', tags: ['bundle'] }, exec)
assert.equal(kbResult.ok, true)

const searchTool = registered.tools.find(tool => tool.name === 'agent_knowledge_search')
const found = await searchTool.execute({ query: 'bundle' }, exec)
assert.equal(found.ok, true)
assert.equal(found.entries.length, 1)
assert.equal(found.entries[0].id, kbResult.entry)

const readTool = registered.tools.find(tool => tool.name === 'agent_knowledge_read')
const full = await readTool.execute({ entry: kbResult.entry }, exec)
assert.equal(full.ok, true)
assert.ok(full.content.includes('链接'))
console.log('tools ok')

// ── handoff status/reset over HTTP ──────────────────────────────────────────
// Services are pended on at call time, so the mocks can land after apply.
ctx.get = name => {
  if (name === 'agents') return { list: () => [{ id: 'session-test-1234' }] }
  if (name === 'sessions') {
    return { get: sessionId => ({ id: sessionId, header: String(sessionId).includes('sub') ? { origin: 'subagent' } : {} }) }
  }
  if (name === 'tokenMeter') return { measure: () => ({ totalTokens: 310000 }) }
  if (name === 'workingDirectory') return { get: () => 'E:\\work' }
  if (name === 'approval') {
    return {
      overrideOf: () => 'never',
      setPolicy: (agent, policy) => approvalCalls.push([agent.id, policy]),
    }
  }
  return undefined
}
const approvalCalls = []
const preStep = registered.handlers.find(item => item.event === 'agent/pre-step').handler
await call('POST', '/op', { op: 'binding.set', args: { sessionId: 'session-test-1234', agentId: id } })
await preStep({ agent: { id: 'session-test-1234' } }, async () => {})
const status = await call('POST', '/op', { op: 'handoff.status', args: {} })
assert.equal(status.status, 200)
assert.equal(status.payload.value.config.triggerTokens, 300000)
assert.equal(status.payload.value.capabilities.arm, true)
assert.equal(status.payload.value.sessions.length, 1)
assert.equal(status.payload.value.sessions[0].agentId, id)
assert.equal(status.payload.value.sessions[0].stage, 'requested')
assert.ok(status.payload.value.sessions[0].requestedAt)
assert.equal(status.payload.value.sessions[0].checkpoint, undefined)
const reset = await call('POST', '/op', { op: 'handoff.reset', args: { sessionId: 'session-test-1234' } })
assert.equal(reset.status, 200)
const afterReset = await call('POST', '/op', { op: 'handoff.status', args: {} })
assert.equal(afterReset.payload.value.sessions[0].stage, 'due')
assert.equal(afterReset.payload.value.sessions[0].requestedAt, undefined)
console.log('handoff status/reset ok')

// ── the next fresh session inherits agent + approval policy ────────────────
const nextSession = registered.handlers.find(item => item.event === 'agent/created').handler
const bindings = async () => (await call('POST', '/op', { op: 'binding.list', args: {} })).payload.value
const armed = await call('POST', '/op', { op: 'handoff.arm', args: { sessionId: 'session-test-1234' } })
assert.equal(armed.status, 200)
assert.equal(armed.payload.value.next.agentId, id)
assert.equal(armed.payload.value.next.cwd, 'E:\\work')
assert.equal(armed.payload.value.next.approval, 'never')

// resume is not a new session: the intent survives
await nextSession({ agent: { id: 'session-next-1' }, source: 'resume' })
assert.equal((await bindings()).some(item => item.sessionId === 'session-next-1'), false)
assert.ok((await call('POST', '/op', { op: 'handoff.status', args: {} })).payload.value.sessions[0].armed)

// subagents never capture it
await nextSession({ agent: { id: 'session-sub-1' }, source: 'startup' })
assert.equal((await bindings()).some(item => item.sessionId === 'session-sub-1'), false)

// a real fresh session consumes it once, binding the same agent and policy
await nextSession({ agent: { id: 'session-next-2' }, source: 'startup' })
const bound = (await bindings()).find(item => item.sessionId === 'session-next-2')
assert.equal(bound?.agentId, id)
assert.deepEqual(approvalCalls, [['session-next-2', 'never']])
assert.equal((await call('POST', '/op', { op: 'handoff.status', args: {} })).payload.value.sessions[0].armed, false)

// the next session after that does not inherit anything
await nextSession({ agent: { id: 'session-next-3' }, source: 'startup' })
assert.equal((await bindings()).some(item => item.sessionId === 'session-next-3'), false)
assert.deepEqual(approvalCalls, [['session-next-2', 'never']])
console.log('handoff next-session inheritance ok')

// ── errors ──────────────────────────────────────────────────────────────────
const bad = await call('POST', '/op', { op: 'nope' })
assert.equal(bad.status, 400)
assert.equal(bad.payload.error.code, 'bad-op')

const missing = await call('GET', '/nowhere')
assert.equal(missing.status, 404)

const forbiddenRes = fakeRes()
await registered.routes[0].handler(
  { method: 'GET', url: '/api/agent-memory/state', headers: { host: 'evil.example.com' } },
  forbiddenRes,
)
assert.equal(forbiddenRes.out.status, 403)
console.log('errors + trust fence ok')

// ── discussion rooms + private journal over HTTP ────────────────────────────
const room = await call('POST', '/op', { op: 'room.create', args: { name: '测试室' } })
const roomId = room.payload.value.id
assert.match(roomId, /^r-[a-z0-9]{4,12}$/)
await call('POST', '/op', { op: 'room.members', args: { id: roomId, members: [id, secondId] } })
await call('POST', '/op', { op: 'room.say', args: { id: roomId, text: '你好' } })
const transcript = await call('POST', '/op', { op: 'room.read', args: { id: roomId } })
assert.equal(transcript.payload.value.total, 1)
assert.equal(transcript.payload.value.messages[0].from.kind, 'user')
const roomList = await call('POST', '/op', { op: 'room.list', args: {} })
assert.equal(roomList.payload.value.rooms.length, 1)
assert.deepEqual(roomList.payload.value.rooms[0].members, [id, secondId])

await call('POST', '/op', { op: 'journal.write', args: { id, title: '日志一', text: '只有这个智能体能看到的细节' } })
const journal = await call('POST', '/op', { op: 'journal.list', args: { id } })
assert.equal(journal.payload.value.total, 1)
assert.equal(journal.payload.value.entries[0].title, '日志一')
const otherJournal = await call('POST', '/op', { op: 'journal.list', args: { id: secondId } })
assert.equal(otherJournal.payload.value.total, 0)
console.log('rooms + journal ok')

// ── teardown ────────────────────────────────────────────────────────────────
for (const effect of registered.effects) {
  if (typeof effect.disposer === 'function') effect.disposer()
}
fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL HOST TESTS PASSED')
