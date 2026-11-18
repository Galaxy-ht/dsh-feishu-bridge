/**
 * Thin transport over the local `lark-cli`.
 *
 * The bridge never stores Feishu credentials: `lark-cli` already owns the
 * authenticated app, so every send/patch/receive goes through it. Sends are
 * serialized through a small queue because each call spawns a process, and a
 * burst of streaming updates must not fork twenty of them at once.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 4 * 1024 * 1024
const TEMP_DIR = join(tmpdir(), 'dsh-feishu-card')

let active = 0
const waiting = []

/** Run one limited-concurrency job after earlier ones drain. */
async function withSlot(task, limit = 4) {
  if (active >= limit) await new Promise(resolve => waiting.push(resolve))
  active += 1
  try {
    return await task()
  } finally {
    active -= 1
    const next = waiting.shift()
    if (next) next()
  }
}

/** Resolve how to invoke `lark-cli` without relying on shell resolution. */
export function larkInvocation() {
  const appData = process.env.APPDATA
  const entry = appData ? join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js') : ''
  if (process.platform === 'win32' && existsSync(entry)) {
    return { file: nodeExecutable(), prefix: [entry] }
  }
  if (appData && existsSync(join(appData, 'npm', 'lark-cli.cmd'))) {
    return { file: join(appData, 'npm', 'lark-cli.cmd'), prefix: [] }
  }
  return { file: process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli', prefix: [] }
}

function nodeExecutable() {
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'node.exe' : 'node')
    if (existsSync(candidate)) return candidate
  }
  return 'node'
}

/** Spawn `lark-cli` and return raw stdout. */
export async function runLark(args, { timeout = 45_000 } = {}) {
  const invocation = larkInvocation()
  const { stdout } = await execFileAsync(invocation.file, [...invocation.prefix, ...args], {
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    timeout,
    encoding: 'utf8',
  })
  return stdout
}

/** Run `lark-cli` and parse its JSON output. */
export async function runLarkJson(args, options) {
  const raw = await runLark([...args, '--format', 'json'], options)
  try { return JSON.parse(raw) } catch { return null }
}

/** Write a payload to a UTF-8 temp file; `@path` keeps it off the command line. */
export function payloadFile(value) {
  mkdirSync(TEMP_DIR, { recursive: true })
  const file = join(TEMP_DIR, `${randomUUID()}.json`)
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  return file
}

/** Remove a temp payload, ignoring a missing file. */
export function disposePayload(file) {
  try { unlinkSync(file) } catch { /* best effort */ }
}

/** Depth-first search for the first `message_id` in any response shape. */
export function findMessageId(payload) {
  let found = ''
  const walk = (node, depth) => {
    if (found || depth > 6 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node.message_id === 'string' && node.message_id) { found = node.message_id; return }
    for (const value of Object.values(node)) walk(value, depth + 1)
  }
  walk(payload, 0)
  return found
}

/** Depth-first search for the first `chat_id` in any response shape. */
export function findChatId(payload) {
  let found = ''
  const walk = (node, depth) => {
    if (found || depth > 6 || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node.chat_id === 'string' && node.chat_id) { found = node.chat_id; return }
    for (const value of Object.values(node)) walk(value, depth + 1)
  }
  walk(payload, 0)
  return found
}

/** Resolve the authorized Feishu user (open id plus display name). */
export async function currentUser() {
  // `auth status` has no `--format` flag: it already prints a JSON document.
  const raw = await runLark(['auth', 'status'], { timeout: 30_000 })
  const status = JSON.parse(raw)
  const identity = status?.identities?.user
  if (typeof identity?.openId !== 'string' || identity.openId.length === 0) {
    throw new Error('飞书用户身份不可用，请先运行 lark-cli auth login --recommend')
  }
  return { openId: identity.openId, name: identity.userName || '' }
}

/** Read identity readiness for diagnostics; never throws. */
export async function authStatus() {
  try {
    return JSON.parse(await runLark(['auth', 'status'], { timeout: 20_000 }))
  } catch {
    return null
  }
}

/**
 * Send one interactive card.
 *
 * With `rootId` the card is posted inside that topic, otherwise it becomes a
 * new main-window message. Returns the message id the caller must keep for
 * later patches and reply routing.
 */
export async function sendCard({ openId, chatId, rootId, card, idempotencyKey }) {
  const file = payloadFile(JSON.stringify(card))
  try {
    const args = rootId
      ? ['im', '+messages-reply', '--as', 'bot', '--message-id', rootId, '--reply-in-thread']
      : ['im', '+messages-send', '--as', 'bot', chatId ? '--chat-id' : '--user-id', chatId || openId]
    return await withSlot(async () => {
      const payload = await runLarkJson([
        ...args,
        '--msg-type', 'interactive',
        '--content', `@${file.replace(/\\/g, '/')}`,
        '--idempotency-key', String(idempotencyKey).slice(0, 50),
      ])
      return { messageId: findMessageId(payload), chatId: findChatId(payload), raw: payload }
    })
  } finally {
    disposePayload(file)
  }
}

/** Replace the whole card on an interactive message. */
export async function patchCard(messageId, card) {
  const file = payloadFile(JSON.stringify({ content: JSON.stringify(card) }))
  try {
    return await withSlot(() => runLarkJson([
      'im', 'messages', 'patch',
      '--as', 'bot',
      '--message-id', messageId,
      '--data', `@${file.replace(/\\/g, '/')}`,
    ], { timeout: 30_000 }))
  } finally {
    disposePayload(file)
  }
}

/** Send plain markdown (fallback path and long-answer continuations). */
export async function sendMarkdown({ openId, chatId, rootId, markdown, idempotencyKey, thread = true }) {
  const args = rootId && thread
    ? ['im', '+messages-reply', '--as', 'bot', '--message-id', rootId, '--reply-in-thread']
    : ['im', '+messages-send', '--as', 'bot', chatId ? '--chat-id' : '--user-id', chatId || openId]
  return withSlot(async () => {
    const payload = await runLarkJson([
      ...args,
      '--markdown', markdown,
      '--idempotency-key', String(idempotencyKey).slice(0, 50),
    ])
    return { messageId: findMessageId(payload), chatId: findChatId(payload) }
  })
}

/** One retry for a transient network/CLI failure. */
export async function retrying(task, attempts = 2, onError) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      onError?.(error, attempt)
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 800 * attempt))
    }
  }
  throw lastError
}

/**
 * Stream one Feishu event key as NDJSON.
 *
 * stdin stays open on purpose: `lark-cli` treats EOF as a request to stop an
 * unbounded consumer, so `ignore` would exit immediately.
 */
export function startConsumer(eventKey, onEvent, { onLog, onExit } = {}) {
  const invocation = larkInvocation()
  const child = spawn(invocation.file, [
    ...invocation.prefix,
    'event', 'consume', eventKey,
    '--as', 'bot',
    '--quiet',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

  let buffer = ''
  let stderrTail = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      try { onEvent(parsed) } catch (error) { onLog?.(`handler failed: ${error?.message || error}`) }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    stderrTail = (stderrTail + text).slice(-4000)
  })
  child.on('error', error => onLog?.(`consumer error: ${error?.message || error}`))
  child.on('exit', (code, signal) => {
    onExit?.({ code, signal, stderr: stderrTail })
    onLog?.(`consumer ${eventKey} exited code=${code} signal=${signal || ''}`)
  })
  return child
}

/**
 * Run `lark-cli` and return stdout and stderr together.
 *
 * Some subcommands (notably `event status`) print their human-readable report on
 * stderr, so a caller that needs the text must read both streams. Failures are
 * returned as text instead of thrown: the caller is inspecting state.
 */
export async function runLarkCombined(args, { timeout = 20_000 } = {}) {
  const invocation = larkInvocation()
  try {
    const { stdout, stderr } = await execFileAsync(invocation.file, [...invocation.prefix, ...args], {
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      timeout,
      encoding: 'utf8',
    })
    return `${stdout}\n${stderr}`
  } catch (error) {
    return `${error?.stdout || ''}\n${error?.stderr || ''}`
  }
}

/**
 * Kill stale `event consume` processes for the keys this bridge owns.
 *
 * `lark-cli` keeps a long-lived bus and each generation of the plugin spawns
 * its own consumer. A reload that leaks a consumer would make every stale
 * generation answer the same Feishu message, so the newest instance adopts the
 * bus by dropping earlier consumers of its own event keys.
 */
export async function stopForeignConsumers(eventKeys) {
  const text = await runLarkCombined(['event', 'status'])
  const victims = new Set()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/pid=(\d+)\s+(\S+)/)
    if (!match) continue
    if (!eventKeys.includes(match[2])) continue
    victims.add(Number(match[1]))
  }
  for (const pid of victims) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(pid, 'SIGTERM')
      }
    } catch { /* already gone */ }
  }
  return victims.size
}
/**
 * Stop a consumer and its children.
 *
 * `lark-cli` runs the event loop in a grandchild process on Windows, so a plain
 * `child.kill()` would leave an orphan that keeps receiving events (and every
 * stale generation would then answer the same message). Kill the whole tree.
 */
export function stopConsumer(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  } catch { /* already gone */ }
}
