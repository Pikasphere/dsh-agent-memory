/**
 * Handoff: watch context pressure and turn a long session into a checkpoint.
 *
 * The checkpoint is not a workspace file — it becomes a journal entry of kind
 * `checkpoint`, so it belongs to the agent's private record and is found again
 * with `agent_journal`. A markdown copy is written only when the user sets an
 * export directory.
 *
 * This module owns configuration, per-session stage, and text generation. It
 * never touches the model, the session log, or the journal store directly.
 *
 * @module handoff
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryError } from './store.js'

export const DEFAULT_TRIGGER_TOKENS = 300000
export const DEFAULT_REMIND_EVERY = 2
const MIN_TOKENS = 20000
const MAX_TOKENS = 2000000

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

function clampTokens(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), MIN_TOKENS), MAX_TOKENS)
}

function shortSession(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
}

export function createHandoff(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const files = {
    config: path.join(root, 'handoff.json'),
    states: path.join(root, 'handoff-state.json'),
  }

  function config() {
    const raw = readJson(files.config, {})
    return {
      version: 1,
      enabled: raw.enabled !== false,
      triggerTokens: clampTokens(raw.triggerTokens, DEFAULT_TRIGGER_TOKENS),
      remindEverySteps: Math.min(Math.max(Math.round(Number(raw.remindEverySteps) || DEFAULT_REMIND_EVERY), 1), 20),
      exportDir: typeof raw.exportDir === 'string' ? raw.exportDir.trim() : '',
    }
  }

  function saveConfig(patch = {}) {
    const current = config()
    const next = { ...current }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.triggerTokens !== 'undefined') next.triggerTokens = clampTokens(patch.triggerTokens, current.triggerTokens)
    if (typeof patch.remindEverySteps !== 'undefined') {
      next.remindEverySteps = Math.min(Math.max(Math.round(Number(patch.remindEverySteps) || current.remindEverySteps), 1), 20)
    }
    if (typeof patch.exportDir === 'string') next.exportDir = patch.exportDir.trim()
    writeAtomic(files.config, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  function allStates() {
    const raw = readJson(files.states, {})
    return raw && typeof raw.sessions === 'object' && raw.sessions !== null ? raw.sessions : {}
  }

  function saveStates(sessions) {
    writeAtomic(files.states, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`)
  }

  function stateOf(sessionId) {
    return allStates()[String(sessionId ?? '')] ?? null
  }

  function patchState(sessionId, patch) {
    const key = String(sessionId ?? '')
    if (key === '') return null
    const sessions = allStates()
    sessions[key] = { ...(sessions[key] ?? {}), ...patch }
    saveStates(sessions)
    return sessions[key]
  }

  function clearState(sessionId) {
    const key = String(sessionId ?? '')
    const sessions = allStates()
    if (sessions[key] === undefined) return
    delete sessions[key]
    saveStates(sessions)
  }

  /**
   * Decide this step's stage from pressure plus what the agent has recorded
   * since the request. `requested` means "remind the model"; `ready` means both
   * a memory and a journal entry landed after the request.
   */
  function evaluate(input = {}) {
    const sessionId = String(input.sessionId ?? '')
    const tokens = Number.isFinite(Number(input.tokens)) ? Number(input.tokens) : 0
    const current = config()
    if (!current.enabled) return { stage: 'off', remind: false, tokens, threshold: current.triggerTokens }
    if (sessionId === '') return { stage: 'off', remind: false, tokens, threshold: current.triggerTokens }

    const state = stateOf(sessionId)
    const threshold = current.triggerTokens
    if (state?.settledAt !== undefined) return { stage: 'settled', remind: false, tokens, threshold, state }
    if (tokens < threshold) {
      if (state?.requestedAt !== undefined && tokens < Math.floor(threshold * 0.9)) clearState(sessionId)
      return { stage: 'watching', remind: false, tokens, threshold, state: state ?? null }
    }
    if (state?.requestedAt === undefined) {
      const requestedAt = now().toISOString()
      patchState(sessionId, { requestedAt, lastTokens: tokens, ticks: 0 })
      return { stage: 'requested', remind: true, tokens, threshold, requestedAt }
    }
    const requestedTime = Date.parse(state.requestedAt)
    const memoryDone = typeof input.memoryAt === 'string' && input.memoryAt !== '' && Date.parse(input.memoryAt) >= requestedTime
    const journalDone = typeof input.journalAt === 'string' && input.journalAt !== '' && Date.parse(input.journalAt) >= requestedTime
    if (memoryDone && journalDone) {
      return { stage: 'ready', remind: false, tokens, threshold, requestedAt: state.requestedAt, state }
    }
    // Repeat the reminder only every `remindEverySteps` steps: the first request
    // already fired, so ticking before the modulo keeps the cadence honest.
    const ticks = Number(state.ticks ?? 0) + 1
    const every = Math.max(1, Number(current.remindEverySteps) || 1)
    patchState(sessionId, { lastTokens: tokens, ticks })
    return {
      stage: 'requested',
      remind: ticks % every === 0,
      ticks,
      tokens,
      threshold,
      requestedAt: state.requestedAt,
      state,
    }
  }

  function buildCheckpointText(input = {}) {
    const at = now().toISOString()
    const lines = [
      '# 交棒检查点',
      '',
      `- 智能体：${input.agentName ?? ''} (${input.agentId ?? ''})`,
      `- 时间：${at}`,
      `- 会话：${input.sessionId ?? ''}`,
      `- 上下文压力：${Number(input.tokens ?? 0).toLocaleString('en-US')} tokens（阈值 ${Number(input.threshold ?? 0).toLocaleString('en-US')}）`,
      '',
      '## 记忆',
      '',
      String(input.memory ?? '').trim() || '(空)',
      '',
      '## 最近的日志',
      '',
    ]
    const entries = Array.isArray(input.entries) ? input.entries.slice(0, 5) : []
    if (entries.length === 0) lines.push('(无)')
    else for (const entry of entries) lines.push(`- ${entry.at ?? ''} · ${entry.title ?? entry.id} (${entry.id})`)
    return lines.join('\n')
  }

  /** Optional markdown copy; an empty export dir means "journal only". */
  function exportCheckpoint(input = {}) {
    const current = config()
    if (current.exportDir === '') return ''
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const file = path.join(current.exportDir, `checkpoint-${shortSession(input.sessionId)}-${stamp}.md`)
    try {
      writeAtomic(file, String(input.text ?? ''))
      return file
    } catch (error) {
      throw new MemoryError('export-failed', `could not write ${file}: ${String(error?.message ?? error)}`)
    }
  }

  return { root, files, config, saveConfig, stateOf, patchState, clearState, evaluate, buildCheckpointText, exportCheckpoint }
}
