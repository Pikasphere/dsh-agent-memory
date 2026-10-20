/**
 * Private journals: the detailed, diary-like record of one agent.
 *
 * One file per agent, append-only. A journal is deliberately *not* shared: the
 * tools always resolve the calling conversation's agent and never accept another
 * agent id, so an agent can only ever read or extend its own journal. The agent
 * decides when to consult it; nothing is injected automatically.
 *
 * Layout: <root>/journal/<agentId>.jsonl — one JSON entry per line.
 *
 * @module journal
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryError } from './store.js'

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const ENTRY_ID = /^j-[a-z0-9]{4,16}$/
const MAX_TEXT = 20000

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

export function createJournals(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const dir = path.join(root, 'journal')

  function fileOf(agentId) {
    const key = String(agentId ?? '')
    if (!AGENT_ID.test(key)) throw new MemoryError('bad-vault', `invalid agent id: ${key || '(empty)'}`)
    return path.join(dir, `${key}.jsonl`)
  }

  function readAll(agentId) {
    let raw = ''
    try {
      raw = fs.readFileSync(fileOf(agentId), 'utf8')
    } catch {
      return []
    }
    const entries = []
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim()
      if (text === '') continue
      try {
        const entry = JSON.parse(text)
        if (entry !== null && typeof entry === 'object' && ENTRY_ID.test(String(entry.id ?? ''))) entries.push(entry)
      } catch {
        /* a torn line is skipped, never fatal */
      }
    }
    return entries
  }

  function count(agentId) {
    try {
      return readAll(agentId).length
    } catch {
      return 0
    }
  }

  /** Timestamp of the latest ordinary entry, used by the handoff watcher. */
  function latestAt(agentId) {
    try {
      const all = readAll(agentId)
      for (let index = all.length - 1; index >= 0; index -= 1) {
        if ((all[index].kind ?? 'note') !== 'checkpoint') return all[index].at ?? ''
      }
      return ''
    } catch {
      return ''
    }
  }

  function list(input = {}) {
    const agentId = String(input.id ?? '')
    const query = collapse(input.query).toLowerCase()
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100)
    const includeCheckpoints = input.includeCheckpoints === true
    const all = readAll(agentId)
    const scoped = includeCheckpoints ? all : all.filter(entry => (entry.kind ?? 'note') !== 'checkpoint')
    const matching =
      query === ''
        ? scoped
        : scoped.filter(entry => {
            const haystack = `${entry.title ?? ''}\n${entry.text ?? ''}`.toLowerCase()
            return query.split(' ').filter(Boolean).every(token => haystack.includes(token))
          })
    const entries = matching.slice(-limit).reverse()
    return {
      id: agentId,
      total: all.length,
      matching: matching.length,
      entries: entries.map(entry => ({
        id: entry.id,
        at: entry.at,
        kind: entry.kind ?? 'note',
        title: entry.title ?? '',
        preview: collapse(entry.text).slice(0, 160),
      })),
    }
  }

  function read(input = {}) {
    const agentId = String(input.id ?? '')
    const entryId = String(input.entry ?? '')
    if (!ENTRY_ID.test(entryId)) throw new MemoryError('bad-entry', `invalid entry id: ${entryId || '(empty)'}`)
    const found = readAll(agentId).find(entry => entry.id === entryId)
    if (found === undefined) throw new MemoryError('no-entry', `no journal entry "${entryId}"`)
    return {
      id: found.id,
      at: found.at,
      kind: found.kind ?? 'note',
      title: found.title ?? '',
      text: found.text ?? '',
      meta: found.meta ?? null,
    }
  }

  function write(input = {}) {
    const agentId = String(input.id ?? '')
    const text = String(input.text ?? '').replace(/\r\n/g, '\n').trim()
    if (text === '') throw new MemoryError('empty-entry', 'journal text must not be empty')
    if (text.length > MAX_TEXT) {
      throw new MemoryError('entry-too-long', `journal entry is ${text.length} characters; the limit is ${MAX_TEXT}`)
    }
    const title = collapse(input.title).slice(0, 100) || collapse(text.split('\n')[0]).slice(0, 100)
    const kind = input.kind === 'checkpoint' ? 'checkpoint' : 'note'
    const entry = {
      id: `j-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      at: new Date().toISOString(),
      kind,
      title,
      text,
    }
    if (input.meta !== undefined && input.meta !== null && typeof input.meta === 'object') {
      entry.meta = input.meta
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(fileOf(agentId), `${JSON.stringify(entry)}\n`, 'utf8')
    return { id: entry.id, at: entry.at, kind, title: entry.title, chars: text.length }
  }

  function remove(input = {}) {
    const agentId = String(input.id ?? '')
    const entryId = String(input.entry ?? '')
    if (!ENTRY_ID.test(entryId)) throw new MemoryError('bad-entry', `invalid entry id: ${entryId || '(empty)'}`)
    const all = readAll(agentId)
    const kept = all.filter(entry => entry.id !== entryId)
    if (kept.length === all.length) throw new MemoryError('no-entry', `no journal entry "${entryId}"`)
    writeAtomic(fileOf(agentId), kept.map(entry => `${JSON.stringify(entry)}\n`).join(''))
    return { removed: entryId }
  }

  return { root, dir, list, read, write, remove, count, latestAt, fileOf }
}
