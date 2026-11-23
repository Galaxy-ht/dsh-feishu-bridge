/**
 * Local configuration, persistent bindings, and the diagnostic log.
 *
 * The bridge keeps two small files under the DSH home: one optional JSON
 * config, and one binding map that ties every Feishu message back to the DSH
 * session that produced it. Both live next to the host, not in the plugin.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')
export const CONFIG_PATH = join(HOME, 'feishu-card.json')
export const STATE_PATH = join(HOME, 'feishu-card-bindings.json')
export const LOG_PATH = join(HOME, 'feishu-card.log')

const MAX_LOG_BYTES = 2 * 1024 * 1024

/** Append one diagnostic line; a broken log must never break delivery. */
export function debugLog(message) {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_BYTES) {
      writeFileSync(LOG_PATH, '', 'utf8')
    }
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch { /* diagnostics are best effort */ }
}

function envFlag(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return !/^(0|false|no|off)$/i.test(String(raw).trim())
}

function envNumber(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/**
 * Effective configuration: defaults < `feishu-card.json` < environment.
 *
 * `thread` keeps the hybrid listing behaviour (first card visible, later cards
 * inside its topic); `cards: false` falls back to plain markdown messages.
 */
export function readConfig() {
  let file = {}
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object') file = parsed
  } catch { /* no config file: use defaults */ }

  const card = file.card && typeof file.card === 'object' ? file.card : {}
  const interval = envNumber('DSH_FEISHU_CARD_INTERVAL', Number(card.intervalMs) || 350)
  return {
    path: CONFIG_PATH,
    thread: envFlag('DSH_FEISHU_THREAD', file.thread === true),
    feishuOnly: envFlag('DSH_FEISHU_ASK_ONLY', file.feishuOnly === true),
    cards: envFlag('DSH_FEISHU_CARDS', file.cards !== false),
    firstUpdateMs: Number(card.firstUpdateMs) || 150,
    intervalMs: Math.min(Math.max(interval, 200), 5000),
    concurrency: Math.min(Math.max(Number(card.maxInflight) || 3, 1), 4),
    maxCardBytes: Math.min(Number(card.maxCardBytes) || 27_000, 29_000),
    maxAnswerChars: Number(card.maxAnswerChars) || 20_000,
    showReasoning: card.showReasoning === true,
    reasoningPreview: card.reasoningPreview !== false,
    showTools: card.showTools !== false,
    footer: card.footer !== false,
    widthMode: ['default', 'compact', 'fill'].includes(card.widthMode) ? card.widthMode : 'default',
    // How a multi-select question is rendered: a dropdown (`multi_select_static`)
    // or a list of checkboxes. Checkboxes are unambiguous but take more room.
    multiSelectStyle: card.multiSelectStyle === 'checker' ? 'checker' : 'dropdown',
    title: typeof card.title === 'string' ? card.title : '',
    catchUp: card.catchUp === true,
    // One private chat per DSH session (1:1 mapping) instead of one shared chat.
    sessionChats: envFlag('DSH_FEISHU_SESSION_CHATS', file.sessionChats !== false),
  }
}

const EMPTY_STATE = () => ({ version: 3, messages: {}, sessions: {}, chats: {}, handledIncoming: {}, stats: {} })

/** Load the persistent binding map, tolerating a missing or partial file. */
export function readBindings() {
  try {
    const value = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (value && typeof value === 'object') {
      const state = { ...EMPTY_STATE(), ...value }
      state.messages ||= {}
      state.chats ||= {}
      state.sessions ||= {}
      state.handledIncoming ||= {}
      state.stats ||= {}
      return state
    }
  } catch { /* first run */ }
  return EMPTY_STATE()
}

/** Persist the binding map, dropping stale de-duplication entries first. */
export function saveBindings(bindings) {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const [id, at] of Object.entries(bindings.handledIncoming || {})) {
      if (Number(at) < cutoff) delete bindings.handledIncoming[id]
    }
    // Keep the file bounded: only recent message bindings are ever consulted.
    const messages = Object.entries(bindings.messages || {})
    if (messages.length > 400) {
      messages.sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0))
      bindings.messages = Object.fromEntries(messages.slice(0, 400))
    }
    mkdirSync(HOME, { recursive: true })
    // Write-then-rename: a crash mid-write must never leave a truncated file
    // that the next start cannot parse.
    const temporary = `${STATE_PATH}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(bindings, null, 2), 'utf8')
    renameSync(temporary, STATE_PATH)
  } catch (error) {
    debugLog(`saveBindings failed: ${error?.message || error}`)
  }
}
