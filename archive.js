/**
 * Two-level conversation archive.
 *
 * The durable session archive itself lives in the Workspace registry
 * (`workspaceController.archiveSession`) and is what hides a conversation from
 * the workspace list and blocks new turns. This module only records how the
 * Agents UI presents that state:
 *
 *   weak    visible under its agent (sidebar + panel), openable for reading
 *   strong  grey and openable in the panel, hidden from the sidebar section
 *
 * @module archive
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryError } from './store.js'

export const ARCHIVE_LEVELS = ['weak', 'strong']

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

export function createArchives(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const file = path.join(root, 'archives.json')
  const now = typeof options.now === 'function' ? options.now : () => new Date()

  function all() {
    const raw = readJson(file, {})
    return raw && typeof raw.sessions === 'object' && raw.sessions !== null ? raw.sessions : {}
  }

  function save(sessions) {
    writeAtomic(file, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`)
  }

  function levelOf(sessionId) {
    const entry = all()[String(sessionId ?? '')]
    return entry !== undefined && ARCHIVE_LEVELS.includes(entry.level) ? entry.level : ''
  }

  function entryOf(sessionId) {
    const entry = all()[String(sessionId ?? '')]
    return entry !== undefined && ARCHIVE_LEVELS.includes(entry.level) ? entry : undefined
  }

  /** Set `weak`, `strong`, or '' to forget the level. `meta` can keep cwd/title. */
  function setLevel(sessionId, level, meta = {}) {
    const key = String(sessionId ?? '')
    if (key === '') throw new MemoryError('bad-session', 'session id required')
    if (level !== '' && level !== null && level !== undefined && !ARCHIVE_LEVELS.includes(level)) {
      throw new MemoryError('bad-level', `unknown archive level: ${String(level)}`)
    }
    const sessions = all()
    if (level === '' || level === null || level === undefined) {
      delete sessions[key]
    } else {
      const previous = sessions[key] ?? {}
      sessions[key] = {
        level,
        at: now().toISOString(),
        ...(typeof previous.cwd === 'string' && previous.cwd !== '' ? { cwd: previous.cwd } : {}),
        ...(typeof meta.cwd === 'string' && meta.cwd !== '' ? { cwd: meta.cwd } : {}),
        ...(typeof previous.title === 'string' && previous.title !== '' ? { title: previous.title } : {}),
        ...(typeof meta.title === 'string' && meta.title !== '' ? { title: meta.title } : {}),
      }
    }
    save(sessions)
    return levelOf(key)
  }

  return { root, file, all, levelOf, entryOf, setLevel }
}
