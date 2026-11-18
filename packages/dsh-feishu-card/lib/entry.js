/**
 * DSH ↔ 飞书 流式卡片桥。
 *
 * 每一轮对话在飞书里是一张持续更新的互动卡片：状态、正文、执行过程、
 * 本轮统计都写在同一张卡上，而不是刷出一串消息。审批与提问也走卡片按钮，
 * 同时保留文字回复作为兜底通道。插件本身从不调用模型。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { buildCard, buildStreamingCard, clip, fitCard, sanitizeMarkdown, streamingParts, summarizeToolArguments } from './card.js'
import * as lark from './lark.js'
import * as feishu from './feishu.js'
import { readBindings, readConfig, saveBindings, debugLog, HOME } from './store.js'

export const name = 'dsh-feishu-card'
export const inject = ['agents']

debugLog('feishu-card module imported')

const MAX_CHUNK = 3500
const esc = value => String(value ?? '').replace(/</g, '&#60;')

/**
 * Normalize a select value.
 *
 * Feishu reports a multi-select as an array in some surfaces and as a
 * comma-separated string in others (standalone `options`, form `form_value`),
 * so both shapes are accepted.
 */
const splitSelection = raw => (Array.isArray(raw)
  ? raw.map(String).map(item => item.trim()).filter(Boolean)
  : (typeof raw === 'string' && raw.trim()
    ? raw.split(/[,，]/).map(item => item.trim()).filter(Boolean)
    : []))
const APPROVAL_HINT = '也可以直接回复本消息：「1」允许、「2」拒绝、「取消」放弃'
const QUESTION_HINT = '也可以直接回复本消息：选项编号（多选形如 1,3）、你的答案，或「取消」跳过'

/** Bot menu `event_key` → the same commands `/dsh ...` accepts. */
const MENU_COMMANDS = {
  dsh_sessions: { kind: 'sessions' },
  dsh_workspaces: { kind: 'workspaces' },
  dsh_doctor: { kind: 'doctor' },
  dsh_preview: { kind: 'preview' },
  dsh_help: { kind: 'help' },
}

/** Turn end reasons mapped to the card's visual state. */
function statusFromReason(reason) {
  switch (reason?.kind) {
    case 'completed': return 'done'
    case 'aborted': return 'aborted'
    case 'error': return 'error'
    case 'max-tokens': return 'max-tokens'
    case 'blocked': return 'blocked'
    case 'interrupted': return 'aborted'
    case 'forked': return 'aborted'
    default: return 'done'
  }
}

/** Human-readable failure text for any non-completed turn end. */
export function failureText(reason) {
  const kind = String(reason?.kind || '')
  if (kind === 'error') {
    const error = reason?.error
    const message = typeof error === 'string' ? error : error?.message
    const code = error?.code
    return `**运行失败**${code ? `（${code}）` : ''}${message ? `\n\n${message}` : ''}`
  }
  if (kind === 'max-tokens') return '**已达到最大 Token 限制**，本轮输出被截断。'
  if (kind === 'interrupted') return '**任务被中断**（进程曾异常退出）。'
  if (kind === 'aborted') return '**已中断**。'
  if (kind === 'blocked') return '**本轮未执行**。'
  return ''
}

/** Join the text blocks of one assistant message. */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'text').map(block => block.text).join('')
}

/** Join the reasoning blocks of one assistant message. */
function reasoningOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(block => block?.type === 'reasoning').map(block => block.text).join('')
}

function textOfToolResult(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks.map(block => (block?.type === 'text' ? block.text : '')).join('')
}

function hashOf(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex')
}

/** Split long text on character boundaries for follow-up messages. */
function splitChunks(text, size = MAX_CHUNK) {
  const chars = Array.from(String(text ?? ''))
  const pieces = []
  for (let offset = 0; offset < chars.length; offset += size) {
    pieces.push(chars.slice(offset, offset + size).join(''))
  }
  return pieces
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  debugLog('feishu-card apply enter')
  try {
    applyInner(ctx)
    debugLog('feishu-card apply done')
  } catch (error) {
    debugLog(`feishu-card apply failed: ${error?.stack || error}`)
    throw error
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
function applyInner(ctx) {
  const CONFIG = readConfig()
  // Only `agents` is a hard dependency; every other Host service is looked up
  // unchecked so a profile without one of them still mounts the bridge.
  const service = key => {
    try { return ctx.get?.(key) } catch { return undefined }
  }
  const services = {
    sessionTitle: service('sessionTitle'),
    workspaceRegistry: service('workspaceRegistry'),
    agentDefaultModel: service('agentDefaultModel'),
    agentPresets: service('agentPresets'),
    tokenMeter: service('tokenMeter'),
    workingDirectory: service('workingDirectory'),
  }
  const bindings = readBindings()
  const turns = new Map()
  const attempts = new Map()
  const pendings = new Map()
  const pendingByMessage = new Map()
  const openBySession = new Map()
  const runningSessions = new Set()
  const timers = new Set()
  const children = []
  let user
  let userPromise
  let disposed = false

  const sessionIdOf = agent => String(agent?.session?.id || agent?.id || '')

  function sessionTitleRaw(session) {
    try {
      const title = services.sessionTitle?.get?.(session)?.title
      if (typeof title === 'string' && title.trim()) return title.trim()
    } catch { /* no title service */ }
    return ''
  }

  function sessionTitleOf(session) {
    return sessionTitleRaw(session) || CONFIG.title || 'DeepSeek Harness'
  }

  function subtitleOf(session) {
    const cwd = String(session?.cwd || '')
    const workspace = cwd ? basename(cwd.replace(/[\\/]+$/, '')) : ''
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    return workspace ? `${workspace} · ${time}` : time
  }

  function ensureUser() {
    if (!userPromise) {
      userPromise = lark.currentUser().then(value => { user = value; return value }).catch(error => {
        userPromise = undefined
        throw error
      })
    }
    return userPromise
  }

  function bindingsFor(sessionId) {
    const existing = bindings.sessions[sessionId]
    if (existing) return existing
    const created = { sessionId, chatId: '', rootMessageId: '', rootVerified: false, updatedAt: Date.now() }
    bindings.sessions[sessionId] = created
    return created
  }

  /**
   * One private Feishu chat per DSH session.
   *
   * This is the 1:1 mapping: every session owns a chat, so its cards never mix
   * with another session and no topic/thread is needed. Created lazily on the
   * first delivery and renamed if the session title changes.
   */
  async function ensureSessionChat(sessionId, title) {
    if (!CONFIG.sessionChats || !feishu.hasCredentials()) return ''
    const session = bindingsFor(sessionId)
    const desired = `DSH · ${clip(title || session.sessionTitle || sessionId.slice(-6), 30)}`
    if (session.chatKind === 'session' && session.chatId) {
      if (session.chatTitle !== desired) {
        session.chatTitle = desired
        saveBindings(bindings)
        guard(feishu.renameChat(session.chatId, desired), 'rename session chat')
      }
      return session.chatId
    }
    const authorized = await ensureUser()
    try {
      const chat = await feishu.createChat({
        name: desired,
        description: 'DeepSeek Harness 会话（1 个 DSH 会话 = 1 个飞书会话）',
        openIds: [authorized.openId],
      })
      session.chatId = chat.chatId
      session.chatKind = 'session'
      session.chatTitle = desired
      session.chatLink = `https://applink.feishu.cn/client/chat/open?openChatId=${chat.chatId}`
      bindings.chats[chat.chatId] = sessionId
      saveBindings(bindings)
      debugLog(`session chat created session=${sessionId} chat=${chat.chatId}`)
      return chat.chatId
    } catch (error) {
      debugLog(`session chat failed session=${sessionId}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200)}`)
      return ''
    }
  }

  /**
   * Post a card and remember which session it belongs to.
   *
   * With per-session chats the card simply lands in its own chat; without them
   * the first card becomes the main-window root and later cards reply into it.
   */
  async function postCard({ sessionId, card, idempotencyKey, asRoot = false, chatId = '', title = '' }) {
    const authorized = await ensureUser()
    const session = bindingsFor(sessionId)
    let target = chatId || ''
    if (!target) target = await ensureSessionChat(sessionId, title)
    if (!target) target = session.chatId || ''
    // A session-owned chat is always flat: one chat per session replaces topics.
    const rootId = asRoot || !CONFIG.thread || target ? '' : String(session.rootMessageId || '')
    const sendCardOnce = () => (feishu.hasCredentials()
      ? feishu.sendCard({
        openId: authorized.openId,
        chatId: target,
        rootId,
        card,
        idempotencyKey,
      })
      : lark.sendCard({
        openId: authorized.openId,
        chatId: target,
        rootId,
        card,
        idempotencyKey,
      }))
    const sent = await lark.retrying(
      sendCardOnce,
      2,
      error => debugLog(`send card failed: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`),
    )
    if (!sent?.messageId) throw new Error('飞书未返回 message_id')
    if (!rootId) {
      session.rootMessageId = sent.messageId
      session.rootVerified = true
    }
    session.chatId = sent.chatId || target || session.chatId || chatId || ''
    session.updatedAt = Date.now()
    bindings.messages[sent.messageId] = {
      sessionId,
      chatId: session.chatId,
      kind: 'card',
      createdAt: Date.now(),
    }
    saveBindings(bindings)
    return sent
  }

  /**
   * Post a CardKit card entity and bind it like any other card.
   *
   * The message only references `card_id`; every later update goes through the
   * entity, which is what allows element-level streaming.
   */
  async function postCardEntity({ sessionId, cardId, idempotencyKey, asRoot = false, chatId = '', title = '' }) {
    const authorized = await ensureUser()
    const session = bindingsFor(sessionId)
    let target = chatId || ''
    if (!target) target = await ensureSessionChat(sessionId, title)
    if (!target) target = session.chatId || ''
    const rootId = asRoot || !CONFIG.thread || target ? '' : String(session.rootMessageId || '')
    const sent = await feishu.sendCardEntity({
      openId: authorized.openId,
      chatId: target,
      rootId,
      cardId,
      idempotencyKey,
    })
    if (!sent?.messageId) throw new Error('飞书未返回 message_id')
    if (!rootId) {
      session.rootMessageId = sent.messageId
      session.rootVerified = true
    }
    session.chatId = sent.chatId || target || session.chatId || chatId || ''
    session.updatedAt = Date.now()
    bindings.messages[sent.messageId] = {
      sessionId,
      chatId: session.chatId,
      kind: 'card',
      createdAt: Date.now(),
    }
    saveBindings(bindings)
    return sent
  }

  // ── turn state ───────────────────────────────────────────────────────────
  /** Only a root agent's work is shown in Feishu; child agents stay internal. */
  function isRootSession(sessionId) {
    try {
      const roots = ctx.agents?.roots?.()
      if (!Array.isArray(roots) || roots.length === 0) return true
      const agent = ctx.agents?.get?.(sessionId)
      if (!agent) return true
      return roots.includes(agent)
    } catch {
      return true
    }
  }

  function ensureTurn(session, turnNumber) {
    const sessionId = String(session?.id || '')
    // Delegated child agents are never surfaced: their work belongs to the
    // parent's own card, and a chat full of child turns is noise.
    if (!isRootSession(sessionId)) return null
    const key = `${sessionId}:${turnNumber}`
    const existing = turns.get(key)
    if (existing) return existing
    const turn = {
      key,
      sessionId,
      session,
      turn: Number(turnNumber),
      title: sessionTitleRaw(session) || bindings.sessions[sessionId]?.sessionTitle || CONFIG.title || 'DeepSeek Harness',
      subtitle: subtitleOf(session),
      startedAt: Date.now(),
      durationMs: 0,
      status: 'running',
      steps: new Map(),
      timeline: [],
      byCall: new Map(),
      usage: undefined,
      model: '',
      contextWindow: 0,
      messageId: '',
      chatId: '',
      cardId: '',
      mode: '',
      sequence: 0,
      sentAnswer: '',
      chromeAt: 0,
      chromeToggle: '',
      inflight: [],
      pumpActive: false,
      pumpTimer: null,
      creating: false,
      createFails: 0,
      lastPatchStart: 0,
      callMs: 0,
      dirty: false,
      finalized: false,
      cardBroken: false,
      patchFails: 0,
      dropped: '',
      failure: '',
      notice: '',
    }
    turns.set(key, turn)
    if (turns.size > 60) {
      for (const [oldKey, old] of turns) {
        if (turns.size <= 40) break
        if (old.finalized) turns.delete(oldKey)
      }
    }
    return turn
  }

  /** The newest non-final turn of one session. */
  function latestLiveTurn(sessionId) {
    let newest = null
    for (const turn of turns.values()) {
      if (turn.sessionId !== sessionId || turn.finalized) continue
      if (!newest || turn.turn > newest.turn) newest = turn
    }
    return newest
  }

  function ensureStep(turn, step) {
    const key = Number(step)
    let entry = turn.steps.get(key)
    if (!entry) {
      entry = { text: '', reasoning: '' }
      turn.steps.set(key, entry)
    }
    return entry
  }

  function joinSteps(turn, field) {
    const ordered = [...turn.steps.entries()].sort((a, b) => a[0] - b[0])
    return ordered.map(([, step]) => step[field]).filter(value => value && value.trim()).join('\n\n')
  }

  function answerOf(turn) {
    return joinSteps(turn, 'text')
  }

  function reasoningOfTurn(turn) {
    return joinSteps(turn, 'reasoning')
  }

  function lastLine(text, limit) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    return clip(lines[lines.length - 1] || '', limit)
  }

  /** The grey second line of the live status block. */
  function activityOf(turn) {
    const runningTool = [...turn.timeline].reverse().find(item => item.state === 'running')
    if (runningTool) return `${runningTool.name}${runningTool.summary ? ` · ${runningTool.summary}` : ''}`
    const answer = answerOf(turn)
    if (answer) return '正在输出…'
    if (CONFIG.reasoningPreview) {
      const preview = lastLine(reasoningOfTurn(turn), 120)
      if (preview) return preview
    }
    return ''
  }

  /** The model this session last used, read from the Agent's own selection. */
  function modelOf(turn) {
    if (turn.model) return turn.model
    try {
      const selection = ctx.agents?.get?.(turn.sessionId)?.model?.current?.()
      if (typeof selection?.model === 'string' && selection.model) {
        turn.model = selection.model
        return turn.model
      }
    } catch { /* agent selection unavailable */ }
    try {
      const projection = turn.session?.modelSelection
      const selection = projection?.lastUsed || projection?.next
      if (typeof selection?.model === 'string' && selection.model) {
        turn.model = selection.model
        return turn.model
      }
    } catch { /* projection unavailable */ }
    return ''
  }

  /** Context window of the bound route, when the token meter can report it. */
  function contextWindowOf(turn) {
    if (turn.contextWindow) return turn.contextWindow
    try {
      const pressure = services.tokenMeter?.contextPressure?.(turn.session)
      if (Number(pressure?.contextWindow) > 0) turn.contextWindow = Number(pressure.contextWindow)
    } catch { /* meter unavailable */ }
    return turn.contextWindow
  }

  function metaOf(turn) {
    const usage = turn.usage || {}
    const total = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0)
    const window = contextWindowOf(turn)
    const percent = window > 0 && total > 0 ? Math.min(999, Math.round((total / window) * 100)) : 0
    return {
      model: modelOf(turn),
      durationMs: turn.finalized ? turn.durationMs : Date.now() - turn.startedAt,
      inputTokens: Number(usage.inputTokens || 0),
      outputTokens: Number(usage.outputTokens || 0),
      contextPercent: percent,
    }
  }

  function toolDurationOf(turn) {
    return turn.timeline.reduce((sum, item) => sum + (item.durationMs || 0), 0)
  }

  /** Turn state → card view. The single place that decides what a card shows. */
  function viewOf(turn) {
    const running = turn.status === 'running' || turn.status === 'waiting'
    const answerParts = []
    if (turn.failure) answerParts.push(turn.failure)
    const answer = answerOf(turn)
    if (answer) answerParts.push(answer)
    if (turn.notice) answerParts.push(turn.notice)
    const body = answerParts.join('\n\n')
    return {
      title: turn.title,
      subtitle: turn.subtitle,
      status: turn.status,
      elapsedMs: running ? Date.now() - turn.startedAt : turn.durationMs,
      activity: running ? activityOf(turn) : '',
      // Model output is escaped once here; everything the plugin composes on
      // top of the view (font/quote tags) is left intact for the renderer.
      answer: body ? sanitizeMarkdown(body) : '',
      reasoning: CONFIG.showReasoning ? reasoningOfTurn(turn) : '',
      timeline: CONFIG.showTools
        ? turn.timeline.slice(-14).map(item => ({
          name: item.name,
          summary: item.summary,
          state: item.state,
          durationMs: item.durationMs,
          error: item.error,
        }))
        : [],
      toolDurationMs: toolDurationOf(turn),
      meta: CONFIG.footer ? metaOf(turn) : undefined,
      actions: running
        ? [{ label: '停止', type: 'default', value: { k: 'stop', s: turn.sessionId, t: turn.turn } }]
        : [],
      widthMode: CONFIG.widthMode,
      summary: body || undefined,
    }
  }

  /**
   * One `lark-cli` patch call costs about a second: process start, credential
   * resolution and the HTTP round trip. Waiting for each to finish before
   * starting the next caps the card at ~1 update/second, so streaming looks
   * like a slideshow. Instead a pump keeps up to `maxInflight` updates in the
   * air and spaces starts by roughly the time one call takes; each update
   * still carries the newest state, so the card advances several times a
   * second without ever skipping ahead of itself for long.
   */
  const PATCH_SPACING_RATIO = 0.34

  function patchGap(turn) {
    const call = Number(turn.callMs) || 1100
    return Math.max(CONFIG.intervalMs, call * PATCH_SPACING_RATIO)
  }

  function markDirty(turn) {
    if (disposed || turn.finalized || turn.cardBroken) return
    turn.dirty = true
    startPump(turn)
  }

  function startPump(turn) {
    if (disposed || turn.finalized || turn.cardBroken || turn.pumpActive) return
    turn.pumpActive = true
    const tick = () => {
      turn.pumpTimer = null
      if (disposed || turn.finalized) { turn.pumpActive = false; return }
      try {
        guard(flushTurn(turn), 'pump flush')
      } catch (error) {
        debugLog(`pump tick failed: ${String(error?.message || error).slice(0, 300)}`)
      }
      // Heartbeat: with no new content the card would otherwise look frozen
      // between events, so refresh the status line at least every ~1.8s.
      if (Date.now() - (turn.lastFlush || 0) > 1800) turn.dirty = true
      // Heartbeat: distinguishes "nothing changed" from "updates are wedged".
      if (Date.now() - (turn.lastBeat || 0) > 10_000) {
        turn.lastBeat = Date.now()
        debugLog(`pump turn=${turn.turn} mode=${turn.mode || '-'} dirty=${turn.dirty} inflight=${turn.inflight.length} broken=${turn.cardBroken} seq=${turn.sequence}`)
      }
      const next = setTimeout(tick, 120)
      next.unref?.()
      turn.pumpTimer = next
    }
    const first = setTimeout(tick, turn.lastFlush ? 120 : CONFIG.firstUpdateMs)
    first.unref?.()
    turn.pumpTimer = first
  }

  function stopPump(turn) {
    turn.pumpActive = false
    if (turn.pumpTimer) {
      clearTimeout(turn.pumpTimer)
      turn.pumpTimer = null
    }
  }

  /** Create the card once; concurrent ticks all wait on the same attempt. */
  async function createCardOnce(turn) {
    if (turn.creating) return
    if (turn.createFails >= 3) { turn.cardBroken = true; return }
    turn.creating = true
    try {
      const idempotencyKey = `dsh-card-${turn.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}-${turn.turn}-${Date.now()}`
      // Prefer a CardKit entity: it streams text element-by-element with the
      // client's own typewriter, and needs no per-update message patch.
      if (feishu.hasCredentials()) {
        try {
          const card = buildStreamingCard(viewOf(turn))
          turn.cardId = await feishu.createCardEntity(card)
          const sent = await postCardEntity({ sessionId: turn.sessionId, cardId: turn.cardId, idempotencyKey, title: turn.title })
          turn.messageId = sent.messageId
          turn.chatId = sent.chatId
          turn.mode = 'cardkit'
          turn.sentAnswer = streamingParts(viewOf(turn)).answer
          turn.patchFails = 0
          turn.lastFlush = Date.now()
          turn.lastPatchStart = Date.now()
          debugLog(`card entity created session=${turn.sessionId} turn=${turn.turn} card=${turn.cardId} message=${turn.messageId}`)
          return
        } catch (error) {
          debugLog(`cardkit create failed, using message patch: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`)
          turn.cardId = ''
        }
      }
      const { card, dropped } = fitCard(viewOf(turn), CONFIG.maxCardBytes)
      const sent = await postCard({ sessionId: turn.sessionId, card, idempotencyKey, title: turn.title })
      turn.messageId = sent.messageId
      turn.chatId = sent.chatId
      turn.mode = 'patch'
      turn.dropped = dropped
      turn.patchFails = 0
      turn.lastFlush = Date.now()
      turn.lastPatchStart = Date.now()
      debugLog(`card created session=${turn.sessionId} turn=${turn.turn} message=${turn.messageId}`)
    } catch (error) {
      turn.createFails += 1
      debugLog(`card create failed session=${turn.sessionId} turn=${turn.turn} attempt=${turn.createFails}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`)
      if (turn.createFails >= 3) { turn.cardBroken = true; stopPump(turn) }
    } finally {
      turn.creating = false
      // Approvals still waiting from an earlier card follow the conversation
      // into this new one, so nothing is lost between cards.
      if (!turn.finalized && turn.cardId && !turn.approvalsRehosted) {
        turn.approvalsRehosted = true
        guard(rehostApprovals(turn), 'approval carry-over')
      }
      // A quota or network failure can end the turn while the first card is
      // still being created. Without this repaint the card would sit on
      // "运行中" forever and the failure text would never reach Feishu.
      if (turn.finalized && turn.messageId && !turn.latePainted) {
        turn.latePainted = true
        guard(drainFinal(turn), 'late final paint')
      }
    }
  }

  /** Cap what the live card streams so the final card is never shorter. */
  const STREAM_CHARS = 6000

  /**
   * Run one fire-and-forget job without letting a rejection escape.
   *
   * A plugin rejection that reaches the host as an unhandled rejection kills
   * the whole app, so every asynchronous entry point goes through here.
   */
  function guard(promise, label) {
    if (!promise || typeof promise.then !== 'function') return promise
    return promise.catch(error => {
      debugLog(`${label}: ${String(error?.stack || error?.message || error).replace(/\s+/g, ' ').slice(0, 400)}`)
    })
  }

  /**
   * Track a launched job and retire it when it settles.
   *
   * The cleanup cannot live in the job's own `finally`: a job that finishes
   * synchronously would reach it before `job` is initialized (TDZ), which is
   * exactly what crashed the host once.
   */
  function trackJob(turn, job, startedAt) {
    turn.inflight.push(job)
    job.finally(() => {
      turn.callMs = Date.now() - startedAt
      const index = turn.inflight.indexOf(job)
      if (index >= 0) turn.inflight.splice(index, 1)
    }).catch(() => { /* the job already logged its own failure */ })
    return job
  }

  /** Stream the live text into a card entity (CardKit path). */
  function launchStream(turn, startedAt) {
    const job = (async () => {
      try {
        const view = viewOf(turn)
        const parts = streamingParts(view)
        const answer = parts.answer.length > STREAM_CHARS
          ? `${parts.answer.slice(0, STREAM_CHARS)}\n\n…（仍在生成）`
          : parts.answer
        // CardKit orders writes by `sequence`, so exactly one write goes out
        // per tick. Firing several in parallel makes them race and the server
        // rejects the batch with "sequence number compare failed" (300317).
        let elementId = ''
        let content = ''
        if (answer !== turn.sentAnswer) {
          turn.sentAnswer = answer
          elementId = 'answer'
          content = answer
        } else if (Date.now() - (turn.lastFlush || 0) > 1200) {
          // Heartbeat refresh so the elapsed clock keeps moving during long
          // tool runs, with the footer updated every third beat.
          if (turn.beatCount % 3 === 2) {
            elementId = 'meta'
            content = parts.meta
          } else {
            elementId = 'status'
            content = parts.status
          }
          turn.beatCount = Number(turn.beatCount || 0) + 1
        } else if (Date.now() - turn.chromeAt > 900) {
          turn.chromeAt = Date.now()
          if (turn.chromeToggle === 'meta') {
            turn.chromeToggle = 'status'
            elementId = 'meta'
            content = parts.meta
          } else {
            turn.chromeToggle = 'meta'
            elementId = 'status'
            content = parts.status
          }
        }
        if (elementId) {
          const res = await feishu.streamElement(turn.cardId, elementId, content, ++turn.sequence)
          if (res && res.code !== 0) throw new Error(`stream ${elementId}: ${res.code} ${res.msg || ''}`.trim())
        }
        turn.lastFlush = Date.now()
        turn.patchFails = 0
      } catch (error) {
        const message = String(error?.message || error)
        // A lost sequence race is self-healing: the next tick carries a higher
        // sequence and overwrites it. Counting it as a failure would freeze the
        // card after four ticks.
        if (message.includes('300317')) {
          if (Date.now() - (turn.lastSequenceWarning || 0) > 5000) {
            turn.lastSequenceWarning = Date.now()
            debugLog(`stream sequence race (will retry) session=${turn.sessionId} turn=${turn.turn}`)
          }
          return
        }
        turn.patchFails += 1
        debugLog(`card stream failed session=${turn.sessionId} turn=${turn.turn} attempt=${turn.patchFails}: ${message.replace(/\s+/g, ' ').slice(0, 300)}`)
        if (turn.patchFails >= 4) {
          turn.cardBroken = true
          stopPump(turn)
        }
      }
    })()
    return trackJob(turn, job, startedAt)
  }

  /** Launch one non-blocking patch carrying the newest state. */
  function launchPatch(turn) {
    const startedAt = Date.now()
    turn.dirty = false
    turn.lastPatchStart = startedAt
    if (turn.mode === 'cardkit' && turn.cardId) return launchStream(turn, startedAt)
    const { card, dropped } = fitCard(viewOf(turn), CONFIG.maxCardBytes)
    const job = (async () => {
      try {
        // Direct OpenAPI is several times faster than one lark-cli invocation.
        if (feishu.hasCredentials()) {
          const res = await feishu.patchCard(turn.messageId, card)
          if (res && res.code !== 0) throw new Error(`patch: ${res.code} ${res.msg || ''}`.trim())
        } else {
          await lark.patchCard(turn.messageId, card)
        }
        turn.dropped = dropped
        turn.lastFlush = Date.now()
        turn.patchFails = 0
      } catch (error) {
        turn.patchFails += 1
        debugLog(`card update failed session=${turn.sessionId} turn=${turn.turn} attempt=${turn.patchFails}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`)
        if (turn.patchFails >= 4) {
          turn.cardBroken = true
          stopPump(turn)
        }
      }
    })()
    return trackJob(turn, job, startedAt)
  }

  async function flushTurn(turn, force = false) {
    if (disposed) return
    // An approval write owns the card's sequence while it runs; skipping this
    // tick (the turn stays dirty) keeps the two writers from colliding.
    if (turn.approvalBusy) return
    if (!turn.messageId) {
      await createCardOnce(turn)
      return
    }
    if (turn.cardBroken) return
    // CardKit applies element writes strictly by `sequence`, so two writes may
    // never overlap: a slower one arriving after a faster one is rejected with
    // 300317. Message patches have no such ordering, so only they fan out.
    const limit = turn.mode === 'cardkit' ? 1 : CONFIG.concurrency
    if (turn.inflight.length >= limit) return
    if (!force) {
      if (!turn.dirty) return
      if (Date.now() - (turn.lastPatchStart || 0) < patchGap(turn)) return
    }
    try {
      launchPatch(turn)
    } catch (error) {
      // A launch that throws synchronously cannot be retried meaningfully:
      // stop the card and let finalize fall back to a markdown message.
      turn.cardBroken = true
      stopPump(turn)
      debugLog(`launch failed session=${turn.sessionId} turn=${turn.turn}: ${String(error?.stack || error).replace(/\s+/g, ' ').slice(0, 400)}`)
    }
  }

  /** Wait until every launched update has settled (bounded, never hangs). */
  async function settleInflight(turn) {
    for (let pass = 0; pass < 12 && turn.inflight.length > 0; pass += 1) {
      await Promise.allSettled([...turn.inflight])
    }
  }

  /**
   * Run card writes for approval UI with exclusive ownership of the sequence.
   *
   * The streaming pump and the approval UI both write the same card, and
   * CardKit rejects any write whose `sequence` is not strictly larger than the
   * last accepted one. Holding `approvalBusy` makes the pump skip its ticks
   * until this settles, so the two writers never interleave.
   */
  async function withApprovalCard(turn, run) {
    if (!turn) return undefined
    turn.approvalBusy = true
    try {
      await settleInflight(turn)
      return await run()
    } finally {
      turn.approvalBusy = false
      turn.dirty = true
      markDirty(turn)
    }
  }

  /** Apply the final state after the in-flight updates settle. */
  async function drainFinal(turn) {
    stopPump(turn)
    // An approval repaint may still own the card; the final layout must wait for
    // it, otherwise the last flush is skipped and the card stays "running".
    for (let pass = 0; pass < 100 && turn.approvalBusy; pass += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await settleInflight(turn)
    // A fast turn can end before the first tick created the card; create it now
    // so the final state is never lost.
    if (!turn.messageId && !turn.cardBroken) {
      turn.dirty = true
      await flushTurn(turn, true)
      await settleInflight(turn)
    }
    if (turn.mode === 'cardkit' && turn.cardId) {
      try {
        // Leave streaming mode before the final layout: a card in streaming
        // mode cannot be updated promptly by a callback (e.g. a button press).
        await feishu.setStreaming(turn.cardId, false, ++turn.sequence)
        const { card, dropped } = fitCard(viewOf(turn), CONFIG.maxCardBytes)
        await feishu.updateCardEntity(turn.cardId, card, ++turn.sequence)
        turn.dropped = dropped
        turn.lastFlush = Date.now()
        return
      } catch (error) {
        debugLog(`cardkit finalize failed session=${turn.sessionId} turn=${turn.turn}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`)
      }
    }
    turn.dirty = true
    await flushTurn(turn, true)
    await settleInflight(turn)
  }

  /** Deliver the part of an answer that did not fit into the card. */
  async function sendContinuation(turn, text) {
    if (!text) return
    const pieces = splitChunks(text)
    const session = bindingsFor(turn.sessionId)
    const rootId = CONFIG.thread ? session.rootMessageId : ''
    const authorized = await ensureUser()
    for (let index = 0; index < pieces.length; index += 1) {
      const title = pieces.length > 1 ? `**（续 ${index + 1}/${pieces.length}）**\n\n` : '**（续）**\n\n'
      try {
        const sent = await lark.sendMarkdown({
          openId: authorized.openId,
          chatId: session.chatId,
          rootId,
          markdown: title + pieces[index],
          idempotencyKey: `dsh-cont-${turn.sessionId.slice(-10)}-${turn.turn}-${index}`,
        })
        if (sent.messageId) {
          bindings.messages[sent.messageId] = { sessionId: turn.sessionId, chatId: session.chatId, kind: 'card', createdAt: Date.now() }
        }
      } catch (error) {
        debugLog(`continuation failed session=${turn.sessionId} part=${index + 1}: ${String(error?.message || error).slice(0, 200)}`)
        return
      }
    }
    saveBindings(bindings)
  }

  /**
   * Deliver a turn whose start this instance never saw.
   *
   * Happens when the plugin mounts in the middle of a running turn (a patch
   * reload, or the first turn right after install). Without this the user would
   * simply get nothing for that turn, so the final answer is recovered from the
   * session's derived messages and posted as a finished card.
   */
  async function finalizeLatentTurn(session, data) {
    const sessionId = String(session?.id || '')
    if (!sessionId || !isRootSession(sessionId)) return
    if (turns.has(`${sessionId}:${data?.turn}`)) return
    const turn = ensureTurn(session, data?.turn)
    if (!turn) return
    let text = ''
    try {
      const messages = session?.deriveMessages?.() || []
      for (const message of messages.slice().reverse()) {
        if (message?.role !== 'assistant') continue
        const candidate = textOf(message.content)
        if (candidate) { text = candidate; break }
      }
    } catch { /* derived history unavailable */ }
    if (!text) {
      debugLog(`late turn without recoverable text session=${sessionId} turn=${data?.turn} reason=${data?.reason?.kind || ''}`)
      turns.delete(turn.key)
      return
    }
    turn.steps.set(0, { text, reasoning: '' })
    debugLog(`late turn recovered session=${sessionId} turn=${data?.turn} chars=${text.length}`)
    await finalizeTurn(turn, data?.reason || { kind: 'completed' })
  }

  async function finalizeTurn(turn, reason) {
    if (!turn || turn.finalized) return
    turn.finalized = true
    stopPump(turn)
    turn.durationMs = Date.now() - turn.startedAt
    turn.status = statusFromReason(reason)
    turn.failure = turn.status === 'done' ? '' : failureText(reason)
    // A turn that produced nothing usually means quota, network or model
    // failure; the card alone is too quiet, so ping the owner explicitly.
    if (turn.status !== 'done' && !answerOf(turn)) guard(notifyFailure(turn), 'failure notice')
    // A first turn often finishes before the title service names the session;
    // pick the real title up here so the final card is not left generic.
    const lateTitle = turn.session ? sessionTitleRaw(turn.session) : ''
    if (lateTitle) turn.title = lateTitle
    const answer = answerOf(turn)
    debugLog(`turn end session=${turn.sessionId} turn=${turn.turn} status=${turn.status} chars=${answer.length} tools=${turn.timeline.length} model=${modelOf(turn) || '?'} window=${contextWindowOf(turn) || '?'}`)

    if (CONFIG.cards && !turn.cardBroken) {
      await drainFinal(turn)
      if (turn.dropped) {
        await sendContinuation(turn, turn.dropped)
        turn.dropped = ''
      }
    }
    if (!CONFIG.cards || turn.cardBroken) {
      await sendFallbackMarkdown(turn, reason)
    }

    const session = bindingsFor(turn.sessionId)
    session.sessionTitle = turn.title
    session.lastSentHash = hashOf(answer)
    session.updatedAt = Date.now()
    saveBindings(bindings)

    const cleanup = setTimeout(() => {
      timers.delete(cleanup)
      if (turns.get(turn.key) === turn) turns.delete(turn.key)
    }, 5 * 60 * 1000)
    cleanup.unref?.()
    timers.add(cleanup)
  }

  /** Plain markdown delivery used when cards are disabled or unusable. */
  async function sendFallbackMarkdown(turn, reason) {
    const authorized = await ensureUser().catch(() => null)
    if (!authorized) return
    const session = bindingsFor(turn.sessionId)
    const body = [turn.failure, answerOf(turn)].filter(Boolean).join('\n\n')
    if (!body) return
    const pieces = splitChunks(`${turn.title}\n\n${body}`, 8000)
    for (let index = 0; index < pieces.length; index += 1) {
      try {
        const sent = await lark.sendMarkdown({
          openId: authorized.openId,
          chatId: session.chatId,
          rootId: CONFIG.thread ? session.rootMessageId : '',
          markdown: pieces[index],
          idempotencyKey: `dsh-fallback-${turn.sessionId.slice(-10)}-${turn.turn}-${index}`,
        })
        if (!session.rootMessageId && sent.messageId) {
          session.rootMessageId = sent.messageId
          session.rootVerified = true
        }
        if (sent.messageId) {
          bindings.messages[sent.messageId] = { sessionId: turn.sessionId, chatId: session.chatId, kind: 'card', createdAt: Date.now() }
        }
      } catch (error) {
        debugLog(`fallback markdown failed session=${turn.sessionId}: ${String(error?.message || error).slice(0, 300)}`)
        break
      }
    }
    saveBindings(bindings)
    debugLog(`fallback markdown sent session=${turn.sessionId} kind=${reason?.kind || ''}`)
  }

  // ── live DSH events ──────────────────────────────────────────────────────

  ctx.on('agent/assistant-stream', payload => {
    try {
      const frame = payload?.frame
      if (!frame) return
      if (frame.type === 'start') {
        attempts.set(frame.attemptId, {
          sessionId: sessionIdOf(payload.agent),
          turn: frame.turn,
          step: frame.step,
        })
        if (attempts.size > 400) {
          const oldest = attempts.keys().next().value
          attempts.delete(oldest)
        }
        return
      }
      if (frame.type === 'end') {
        attempts.delete(frame.attemptId)
        return
      }
      const target = attempts.get(frame.attemptId)
      if (!target) return
      const turn = turns.get(`${target.sessionId}:${target.turn}`)
      if (!turn || turn.finalized) return
      const chunk = frame.chunk
      if (!chunk) return
      if (chunk.type === 'text-delta') {
        const step = ensureStep(turn, target.step)
        step.text += chunk.text
      } else if (chunk.type === 'reasoning-delta') {
        const step = ensureStep(turn, target.step)
        step.reasoning += chunk.text
      } else if (chunk.type === 'usage') {
        turn.usage = chunk.usage
      } else {
        return
      }
      markDirty(turn)
    } catch (error) {
      debugLog(`assistant-stream handler failed: ${error?.message || error}`)
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      const data = event?.data || {}
      const sessionId = String(session?.id || '')
      if (!sessionId || !type) return
      const turnKey = `${sessionId}:${data.turn ?? ''}`

      if (type === 'turn/start') {
        const turn = ensureTurn(session, data.turn)
        if (turn) markDirty(turn)
        return
      }
      if (type === 'turn/end') {
        const turn = turns.get(turnKey)
        if (turn) guard(finalizeTurn(turn, data.reason), 'finalize' )
        else guard(finalizeLatentTurn(session, data), 'finalize latent')
        return
      }
      if (type === 'session/title') {
        const title = data.title || data.value
        if (typeof title === 'string' && title.trim()) {
          for (const item of turns.values()) {
            if (item.sessionId === sessionId && !item.finalized) item.title = title.trim()
          }
        }
        return
      }
      // `user/message` carries no turn number, so fall back to the newest live
      // turn of this session when the keyed lookup misses.
      const turn = turns.get(turnKey) || latestLiveTurn(sessionId)
      if (!turn || turn.finalized) return

      switch (type) {
        case 'user/message': {
          // The first real prompt doubles as a title while the session has no
          // generated one, so the card header says what this conversation is.
          if (turn.prompt) break
          const text = textOf(data.content)
          if (!text.trim()) break
          turn.prompt = text
          if (!sessionTitleRaw(turn.session) && /^DeepSeek Harness$/.test(turn.title)) {
            turn.title = clip(text.replace(/\s+/g, ' '), 28)
            const binding = bindingsFor(turn.sessionId)
            binding.sessionTitle = turn.title
            binding.updatedAt = Date.now()
            saveBindings(bindings)
          }
          markDirty(turn)
          break
        }
        case 'tool/call': {
          const item = {
            callId: data.callId,
            name: String(data.name || 'tool'),
            summary: summarizeToolArguments(data.arguments),
            state: 'running',
            startedAt: Date.now(),
            durationMs: 0,
            error: '',
          }
          turn.timeline.push(item)
          turn.byCall.set(String(data.callId), item)
          if (turn.timeline.length > 200) {
            const removed = turn.timeline.splice(0, turn.timeline.length - 200)
            for (const old of removed) turn.byCall.delete(String(old.callId))
          }
          markDirty(turn)
          break
        }
        case 'tool/result': {
          const callId = String(data.message?.toolCallId || data.message?.source?.callId || '')
          const item = turn.byCall.get(callId)
          if (!item) break
          item.finishedAt = Date.now()
          item.durationMs = item.finishedAt - (item.startedAt || item.finishedAt)
          const failed = data.message?.isError === true || Boolean(data.error)
          item.state = failed ? 'error' : 'done'
          if (failed) {
            item.error = clip(
              String(data.error?.reason || data.error?.message || textOfToolResult(data.message) || '执行失败').replace(/\s+/g, ' '),
              160,
            )
          }
          markDirty(turn)
          break
        }
        case 'assistant/message': {
          const step = ensureStep(turn, data.step)
          const text = textOf(data.message?.content)
          const reasoning = reasoningOf(data.message?.content)
          if (text || !step.text) step.text = text
          if (reasoning || !step.reasoning) step.reasoning = reasoning
          if (data.usage) turn.usage = data.usage
          markDirty(turn)
          break
        }
        case 'request/header': {
          const model = data.header?.config?.model
          debugLog(`request/header session=${sessionId} reason=${data.reason || ''} model=${String(model || '')}`)
          if (typeof model === 'string' && model) turn.model = model
          break
        }
        case 'request/context': {
          debugLog(`request/context session=${sessionId} keys=${Object.keys(data || {}).join(',')} window=${Number(data.contextWindow || 0)}`)
          if (Number(data.contextWindow) > 0) turn.contextWindow = Number(data.contextWindow)
          if (typeof data.model === 'string' && data.model) turn.model = turn.model || data.model
          break
        }
        default:
          break
      }
    } catch (error) {
      debugLog(`session event handler failed: ${error?.message || error}`)
    }
  })

  ctx.on('agent/status', payload => {
    try {
      const sessionId = sessionIdOf(payload?.agent)
      if (!sessionId) return
      const status = payload?.status
      if (status === 'running') {
        runningSessions.add(sessionId)
        return
      }
      if (!runningSessions.delete(sessionId)) return
      for (const turn of turns.values()) {
        if (turn.sessionId !== sessionId || turn.finalized) continue
        if (Date.now() - turn.startedAt < 800) continue
        debugLog(`status fallback finalize session=${sessionId} turn=${turn.turn}`)
        guard(finalizeTurn(turn, { kind: 'completed' }), 'finalize fallback')
      }
    } catch (error) {
      debugLog(`agent status fallback failed: ${error?.message || error}`)
    }
  })

  // ── approvals and questions ──────────────────────────────────────────────

  /** Whether card interactions can currently reach the bridge. */
  function actionsAvailable() {
    return bindings.stats?.cardActionsUnavailable !== true
  }

  function pendingKeyOf(messageId) {
    const key = pendingByMessage.get(messageId)
    return key ? pendings.get(key) : undefined
  }

  function trackPending(record) {
    pendings.set(record.key, record)
    if (record.messageId) pendingByMessage.set(record.messageId, record.key)
    let set = openBySession.get(record.sessionId)
    if (!set) { set = new Set(); openBySession.set(record.sessionId, set) }
    set.add(record.key)
  }

  function untrackPending(record) {
    pendings.delete(record.key)
    const set = openBySession.get(record.sessionId)
    if (set) {
      set.delete(record.key)
      if (set.size === 0) openBySession.delete(record.sessionId)
    }
    for (const [id, key] of pendingByMessage) if (key === record.key) pendingByMessage.delete(id)
  }

  /** Repaint a prompt card once it has been answered, keeping the record. */
  async function paintPromptResult(record, outcome, note) {
    if (!record?.messageId) return
    const view = record.view
    if (!view) return
    const answered = outcome === 'allowed-once' || outcome === 'answered'
    const rejected = outcome === 'rejected'
    const next = {
      ...view,
      status: answered ? 'done' : 'aborted',
      subtitle: note ? clip(note, 40) : (answered ? '已记录' : '已结束'),
      activity: '',
      actions: (view.actions || []).map(action => ({ ...action, disabled: true })),
      // A finished prompt must not keep inviting input.
      form: undefined,
      answer: [view.answer, note].filter(Boolean).join('\n\n'),
      hint: '',
      summary: note || view.summary,
    }
    try {
      const { card } = fitCard(next, CONFIG.maxCardBytes)
      if (feishu.hasCredentials()) {
        const res = await feishu.patchCard(record.messageId, card)
        if (res && res.code !== 0) throw new Error(`prompt repaint: ${res.code} ${res.msg || ''}`.trim())
      } else {
        await lark.patchCard(record.messageId, card)
      }
    } catch (error) {
      debugLog(`prompt repaint failed message=${record.messageId}: ${String(error?.message || error).slice(0, 200)}`)
    }
    if (rejected) debugLog(`prompt rejected key=${record.key}`)
  }

  async function answerPending(record, outcome, note) {
    if (!record || record.done) return
    record.done = true
    untrackPending(record)
    debugLog(`pending answered kind=${record.kind} key=${record.key} outcome=${String(outcome).slice(0, 60)}`)
    if (record.ui) {
      // Inline approval: the block disappears and only a history line remains.
      const tool = clip(String(record.request?.toolName || '工具'), 20)
      const mark = outcome === 'allowed-once' ? `✅ 允许 \`${tool}\`` : outcome === 'rejected' ? `❌ 拒绝 \`${tool}\`` : `⏹ 取消 \`${tool}\``
      // Await the repaint before resolving: resolving lets the model stream
      // again, and its card writes would collide with these deletes.
      try { await retractApproval(record, `${mark} · ${new Date().toTimeString().slice(0, 5)}`) }
      catch (error) { debugLog(`approval retract failed: ${String(error?.message || error).slice(0, 160)}`) }
    } else {
      try { await paintPromptResult(record, outcome, note) }
      catch (error) { debugLog(`prompt paint failed: ${String(error?.message || error).slice(0, 160)}`) }
    }
    try { record.resolve?.(outcome) } catch (error) { debugLog(`resolve failed: ${error?.message || error}`) }
  }

  /** Only live root agents may ask the human; a child never gets its own card. */
  function isHumanFacing(agent) {
    if (!agent) return false
    try {
      const roots = ctx.agents?.roots?.()
      if (Array.isArray(roots) && roots.length > 0) return roots.includes(agent)
    } catch { /* registry shape changed: fall through */ }
    return true
  }

  function approvalView(record, request) {
    const available = actionsAvailable()
    return {
      title: sessionTitleOf(request?.agent?.session) || 'DeepSeek Harness',
      subtitle: '等待你的确认',
      status: 'waiting',
      icon: 'approval_colorful',
      fields: [
        { label: '工具', value: `\`${String(request?.toolName || '未知')}\`` },
        { label: '会话', value: clip(record.sessionTitle || '', 40) },
      ],
      answer: [
        request?.reason ? `**授权原因**\n${clip(esc(request.reason), 400)}` : '**DSH 请求执行一次工具调用**',
        ...(available ? [] : ['**1** · 允许一次　　**2** · 拒绝　　**3** · 取消']),
      ].join('\n\n'),
      actions: available
        ? [
          { label: '允许一次', type: 'primary_filled', value: { k: 'approve', id: record.key, v: 'allow' } },
          { label: '拒绝', type: 'danger', value: { k: 'approve', id: record.key, v: 'deny' } },
          { label: '取消', type: 'default', value: { k: 'approve', id: record.key, v: 'cancel' } },
        ]
        : [],
      hint: APPROVAL_HINT,
      widthMode: CONFIG.widthMode,
      summary: `需要审批：${request?.toolName || '工具调用'}`,
    }
  }

  function questionView(record, question, index, total) {
    const options = Array.isArray(question?.options) ? question.options : []
    const labels = options.map(option => clip(option.label, 60))
    const interactive = actionsAvailable()
    const multi = question?.multiSelect === true
    // Single-select with a handful of options reads best as buttons; anything
    // wider (multiSelect, or too many options) becomes a dropdown in the form.
    const useButtons = interactive && !multi && labels.length > 0 && labels.length <= 6
    const useSelect = interactive && labels.length > 0 && !useButtons
    const lines = []
    if (question?.header) lines.push(`**${clip(esc(question.header), 60)}**`)
    lines.push(clip(esc(question?.question || ''), 800))
    if (question?.detail) lines.push(`<font color='grey'>${clip(esc(question.detail), 400)}</font>`)
    if (!interactive && labels.length > 0) {
      lines.push(labels.map((label, optionIndex) => (
        `${optionIndex + 1} · ${label}${options[optionIndex]?.description ? `　<font color='grey'>${clip(options[optionIndex].description, 80)}</font>` : ''}`
      )).join('\n'))
    }
    if (multi && interactive) {
      lines.push("<font color='grey'>这是多选题，可以在下拉里选多个；也可以直接填写自定义答案。</font>")
    }
    return {
      title: total > 1 ? `需要你回答（${index + 1}/${total}）` : '需要你回答',
      subtitle: '等待你的选择',
      status: 'waiting',
      icon: 'ai-common_colorful',
      answer: lines.join('\n\n'),
      actions: useButtons
        ? labels.map((label, optionIndex) => ({
          label,
          type: optionIndex === 0 ? 'primary_filled' : 'default',
          value: { k: 'answer', id: record.key, i: optionIndex },
        }))
        : [],
      // Any question also accepts a free-form answer typed into the card.
      form: interactive
        ? {
          name: `answer_form_${String(question?.id || 'q').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}`,
          options: useSelect ? labels : [],
          multi: useSelect && multi,
          placeholder: useSelect ? '也可以直接输入答案…' : '或者在这里输入你的答案…',
          submitLabel: '提交',
        }
        : undefined,
      hint: useButtons ? QUESTION_HINT : '直接回复你的答案；回复「取消」跳过',
      widthMode: CONFIG.widthMode,
      summary: clip(question?.question || '需要你回答', 80),
    }
  }

  // ── inline approval (merged into the turn's own card) ──────────────────
  //
  // Layout on the turn card, below a rule:
  //   [全部允许 N] [信任本会话]        ← one global row per card
  //   ⚠️ tool 请求执行 / 原因
  //   [允许] [拒绝] [取消]             ← one identical row per approval
  //   ▶ 审批记录（N）                   ← collapsible history
  // A resolved block is deleted outright; only its history line remains.

  /** History lines per card, and the element counter per card. */
  const approvalCards = new Map()

  function approvalCardState(cardId) {
    let state = approvalCards.get(cardId)
    if (!state) {
      state = { counter: 0, lines: [], global: false, history: false, sessionId: '' }
      approvalCards.set(cardId, state)
    }
    return state
  }

  function pendingApprovalsOn(cardId) {
    const list = []
    for (const record of pendings.values()) {
      if (record.done || record.kind !== 'approval') continue
      if (record.ui?.cardId === cardId) list.push(record)
    }
    return list
  }

  const approvalCell = (label, type, value) => ({
    tag: 'column', width: 'weighted', weight: 1,
    elements: [{
      tag: 'button', text: { tag: 'plain_text', content: label }, type, width: 'fill',
      behaviors: [{ type: 'callback', value }],
    }],
  })

  function globalRowView(cardId, extra = 0) {
    const count = pendingApprovalsOn(cardId).length + extra
    const sessionId = approvalCardState(cardId).sessionId || ''
    return {
      tag: 'column_set', element_id: 'ap_g', flex_mode: 'none',
      columns: [
        approvalCell(`全部允许 ${count}`, 'primary', { k: 'approve-all', s: sessionId }),
        approvalCell('信任本会话', 'primary', { k: 'trust', s: sessionId }),
      ],
    }
  }

  function historyOf(sessionId) {
    const store = bindings.approvalHistory
    const list = store && Array.isArray(store[sessionId]) ? store[sessionId] : []
    return list
  }

  function pushHistory(sessionId, line) {
    if (!sessionId || !line) return
    bindings.approvalHistory ||= {}
    bindings.approvalHistory[sessionId] = historyOf(sessionId).concat(line).slice(-20)
    saveBindings(bindings)
  }

  function historyPanelView(cardId) {
    const lines = historyOf(approvalCardState(cardId).sessionId)
    return {
      tag: 'collapsible_panel',
      element_id: 'ap_h',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: `**审批记录（${lines.length}）**` },
        vertical_align: 'center',
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      elements: [{ tag: 'markdown', element_id: 'ap_h_body', content: lines.length > 0 ? lines.join('\n') : '（尚无记录）' }],
    }
  }

  /** Next write order for a card; CardKit requires a strictly increasing sequence. */
  function nextApprovalSequence(turn) {
    // Share the turn's counter: a later streaming write must not step back
    // below an approval write, or CardKit answers 300317.
    const next = Math.max(Number(turn.approvalSequence || 0), Number(turn.sequence || 0)) + 1
    turn.sequence = next
    turn.approvalSequence = next
    return next
  }

  async function refreshApprovalGlobals(turn, extra = 0) {
    const cardId = turn.cardId
    if (!cardId) return
    const state = approvalCardState(cardId)
    if (state.global) {
      await feishu.updateElement(cardId, 'ap_g', globalRowView(cardId, extra), nextApprovalSequence(turn))
        .catch(error => debugLog(`approval global refresh failed: ${String(error?.message || error).slice(0, 120)}`))
    }
    if (state.history) {
      await feishu.updateElement(cardId, 'ap_h', historyPanelView(cardId), nextApprovalSequence(turn))
        .catch(error => debugLog(`approval history refresh failed: ${String(error?.message || error).slice(0, 120)}`))
    }
  }

  /**
   * Put one approval block on the turn card.
   *
   * Returns false when the card cannot host it, so the caller can fall back to
   * a standalone approval card.
   */
  async function inlineApproval(turn, record) {
    if (!turn?.cardId || turn.cardBroken) return false
    const cardId = turn.cardId
    const state = approvalCardState(cardId)
    state.sessionId = String(turn.sessionId || state.sessionId || '')
    state.counter += 1
    const n = state.counter
    const ids = { hr: `ap${n}_hr`, title: `ap${n}_t`, row: `ap${n}_r` }

    const elements = []
    if (!state.global) {
      state.global = true
      elements.push(globalRowView(cardId))
    }
    elements.push(
      { tag: 'hr', element_id: ids.hr },
      { tag: 'markdown', element_id: ids.title, content: `**⚠️ ${clip(String(record.request?.toolName || '工具'), 20)} 请求执行**\n${clip(esc(String(record.request?.reason || 'DSH 请求执行一次工具调用')), 300)}` },
      {
        tag: 'column_set', element_id: ids.row, flex_mode: 'none',
        columns: [
          approvalCell('允许', 'primary_filled', { k: 'approve', id: record.key, v: 'allow' }),
          approvalCell('拒绝', 'danger', { k: 'approve', id: record.key, v: 'deny' }),
          approvalCell('取消', 'default', { k: 'approve', id: record.key, v: 'cancel' }),
        ],
      },
      { tag: 'hr', element_id: `ap${n}_hr2` },
    )
    if (!state.history) {
      state.history = true
      elements.push(historyPanelView(cardId))
    }

    const appended = await withApprovalCard(turn, async () => {
      const res = await feishu.appendElements(cardId, elements, nextApprovalSequence(turn))
        .catch(error => ({ code: -1, msg: String(error?.message || error) }))
      if (res?.code === 0) return res
      // A reload clears the in-memory flags while the card keeps its elements;
      // a duplicate global row or history panel is therefore harmless.
      if (!/duplicate id|300315|300301/i.test(String(res?.msg || ''))) return res
      const rest = elements.filter(element => !['ap_g', 'ap_h'].includes(element.element_id))
      return feishu.appendElements(cardId, rest, nextApprovalSequence(turn))
        .catch(error => ({ code: -1, msg: String(error?.message || error) }))
    })
    if (appended?.code !== 0) {
      debugLog(`inline approval failed: ${String(appended?.msg || '').slice(0, 200)}`)
      state.global = false
      state.history = false
      return false
    }
    record.ui = { cardId, turn, n, ids }
    // The record is tracked by the caller, so count it here explicitly.
    await withApprovalCard(turn, () => refreshApprovalGlobals(turn, 1))
    return true
  }

  /** Remove one resolved block and record it in the collapsed history. */
  async function retractApproval(record, line) {
    const ui = record?.ui
    if (!ui) return
    const { cardId, turn, n, ids } = ui
    const state = approvalCardState(cardId)
    pushHistory(state.sessionId, line)
    await withApprovalCard(turn, async () => {
      for (const id of [ids.hr, ids.title, ids.row, `ap${n}_hr2`]) {
        const res = await feishu.deleteElement(cardId, id, nextApprovalSequence(turn))
          .catch(error => ({ code: -1, msg: String(error?.message || error) }))
        if (res?.code !== 0) debugLog(`approval delete ${id} failed: ${res?.code} ${String(res?.msg || '').slice(0, 120)}`)
      }
      await refreshApprovalGlobals(turn)
      // Nothing left to approve: the global row retires as well.
      if (pendingApprovalsOn(cardId).length === 0 && state.global) {
        await feishu.deleteElement(cardId, 'ap_g', nextApprovalSequence(turn)).catch(() => {})
        state.global = false
      }
    })
  }

  /** Resolve every pending approval on a card (the global buttons). */
  async function resolveAllApprovals(sessionId, trust) {
    const targets = []
    for (const record of pendings.values()) {
      if (record.done || record.kind !== 'approval') continue
      if (record.sessionId !== sessionId) continue
      targets.push(record)
    }
    // Tagged before resolving so each block's history refresh already carries
    // the note; one note per card, not one per approval.
    const tagged = new Set()
    for (const record of targets) {
      const cardId = record.ui?.cardId
      if (trust && cardId && !tagged.has(cardId)) {
        tagged.add(cardId)
        pushHistory(approvalCardState(cardId).sessionId, '🔓 本会话已切换到完全权限')
      }
      await answerPending(record, 'allowed-once', trust ? '已按信任本会话放行。' : '已全部允许。')
    }
    if (trust) {
      try {
        const presets = ctx.get('permissionPresets')
        const catalog = presets?.catalog?.()
        const option = catalog?.options?.find(item => /full|danger/i.test(String(item.value)) || /完全/.test(String(item.name)))
        const session = [...turns.values()].find(turn => turn.sessionId === sessionId)?.session
        if (option && session) presets.set(session, option.value)
        else debugLog(`trust: no full-access preset (options=${(catalog?.options || []).map(item => item.value).join(',')})`)
      } catch (error) {
        debugLog(`trust preset switch failed: ${String(error?.message || error).slice(0, 160)}`)
      }
    }
  }

  /** Re-host approvals that were still pending when the previous card ended. */
  async function rehostApprovals(turn) {
    for (const record of pendings.values()) {
      if (record.done || record.kind !== 'approval') continue
      if (record.sessionId !== turn.sessionId) continue
      if (record.ui?.cardId === turn.cardId) continue
      // Drop the stale block from the finished card before moving the request.
      const previous = record.ui
      if (previous?.cardId) {
        for (const id of [previous.ids.hr, previous.ids.title, previous.ids.row, `ap${previous.n}_hr2`]) {
          await feishu.deleteElement(previous.cardId, id, nextApprovalSequence(previous.turn))
            .catch(() => {})
        }
        record.ui = undefined
      }
      await inlineApproval(turn, record)
    }
  }

  /** Tell the owner explicitly when a turn produced nothing (quota, network…). */
  async function notifyFailure(turn) {
    const authorized = await ensureUser().catch(() => null)
    const openId = authorized?.openId || ''
    if (!openId) return
    const plain = String(turn.failure || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const line = `<at user_id="${openId}"></at> 第 ${turn.turn} 轮失败${plain ? `：${plain}` : ''}`
    const session = bindingsFor(turn.sessionId)
    await feishu.sendMarkdown({ openId, chatId: session.chatId || '', markdown: line })
      .catch(error => debugLog(`failure notice failed: ${String(error?.message || error).slice(0, 160)}`))
  }

  async function onApprovalRequest(request, next) {
    const agent = request?.agent
    if (!isHumanFacing(agent)) return next()
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return next()
    const record = {
      key: `approval:${randomUUID()}`,
      kind: 'approval',
      sessionId,
      sessionTitle: sessionTitleOf(agent?.session),
      done: false,
      request,
    }

    // Preferred: append the approval to the running turn's own card, so the
    // conversation never spawns a second message per confirmation.
    const turn = [...turns.values()].find(item => item.sessionId === sessionId && !item.finalized && item.cardId)
    let hosted = false
    if (turn) hosted = await inlineApproval(turn, record)

    if (!hosted) {
      record.view = approvalView(record, request)
      let sent = null
      try {
        sent = await postCard({
          sessionId,
          card: buildCard(record.view),
          idempotencyKey: `dsh-ask-${randomUUID().slice(0, 24)}`,
        })
      } catch (error) {
        debugLog(`approval card failed session=${sessionId}: ${String(error?.message || error).slice(0, 200)}`)
      }
      if (!sent?.messageId) return next()
      record.messageId = sent.messageId
    }

    trackPending(record)
    // The desktop answerer stays live unless Feishu-only is requested; whichever
    // surface answers first wins and the other wait is dropped.
    const ui = CONFIG.feishuOnly ? null : Promise.resolve().then(() => next()).catch(() => 'unavailable')
    return new Promise(resolve => {
      record.resolve = resolve
      if (ui) {
        ui.then(value => {
          if (value === 'unavailable' || value === undefined) return
          guard(answerPending(record, value, value === 'allowed-once' ? '已允许本次调用。' : '已拒绝本次调用。'), 'desktop answer')
        })
      }
    })
  }

  /** Whether a multi-select question should render as a checkbox list. */
  function useCheckers(question) {
    if (question?.multiSelect !== true) return false
    const options = Array.isArray(question.options) ? question.options : []
    return CONFIG.multiSelectStyle === 'checker' && options.length > 0 && options.length <= 10
  }

  /** One card listing every question, submitted together. */
  function batchQuestionView(record, questions) {
    const fields = []
    questions.forEach((question, index) => {
      const options = Array.isArray(question?.options) ? question.options : []
      const label = [`**${index + 1}. ${clip(esc(question?.question || ''), 240)}**`]
      if (question?.header) label.unshift(`<font color='grey'>${clip(esc(question.header), 40)}</font>`)
      if (question?.detail) label.push(`<font color='grey'>${clip(esc(question.detail), 200)}</font>`)
      fields.push({ kind: 'label', markdown: label.join('\n') })
      if (options.length > 0) {
        // Multi-select is a checkbox list (unambiguous); single-select stays a
        // compact dropdown.
        fields.push(useCheckers(question)
          ? { kind: 'checkers', name: `q${index}`, options: options.map(option => clip(option.label, 60)) }
          : {
            kind: question?.multiSelect === true ? 'multi' : 'select',
            name: `q${index}`,
            options: options.map(option => clip(option.label, 60)),
            placeholder: question?.multiSelect === true ? '可多选（选完点提交）' : '选择一项',
          })
      }
      fields.push({
        kind: 'input',
        name: `q${index}_custom`,
        placeholder: options.length > 0 ? '其他答案（可留空）' : '输入你的答案',
      })
    })
    return {
      title: `需要你回答（共 ${questions.length} 题）`,
      subtitle: '填好后一次提交',
      status: 'waiting',
      icon: 'ai-common_colorful',
      actions: [],
      form: { name: `batch_form_${String(record.key).slice(-6).replace(/[^a-zA-Z0-9]/g, '')}`, fields, submitLabel: '提交全部' },
      hint: '会答的填上，不会的留空即可。',
      widthMode: CONFIG.widthMode,
      summary: `需要你回答 ${questions.length} 个问题`,
    }
  }

  /** Post one batch card and resolve with all answers at once. */
  async function onQuestionBatch(sessionId, questions, next) {
    let settled = false
    let resolveBatch
    const batch = new Promise(resolve => { resolveBatch = resolve })
    const record = {
      key: `batch:${randomUUID()}`,
      kind: 'batch',
      sessionId,
      questions,
      done: false,
    }
    record.view = batchQuestionView(record, questions)
    let sent = null
    try {
      sent = await postCard({
        sessionId,
        card: buildCard(record.view),
        idempotencyKey: `dsh-qb-${randomUUID().slice(0, 24)}`,
      })
    } catch (error) {
      debugLog(`batch question card failed session=${sessionId}: ${String(error?.message || error).slice(0, 200)}`)
    }
    if (!sent?.messageId) return next()
    record.messageId = sent.messageId
    trackPending(record)
    record.applyBatch = (answers, note) => {
      if (record.done) return
      record.done = true
      untrackPending(record)
      guard(paintPromptResult(record, 'answered', note), 'prompt paint')
      if (settled) return
      settled = true
      resolveBatch({ answers })
    }
    if (CONFIG.feishuOnly) return batch
    const ui = Promise.resolve().then(() => next()).catch(() => null)
    ui.then(value => {
      if (settled || !value || !Array.isArray(value.answers)) return
      settled = true
      resolveBatch(value)
    })
    return batch
  }

  async function onQuestionsRequest(request, next) {
    const agent = request?.agent
    if (!isHumanFacing(agent)) return next()
    const sessionId = sessionIdOf(agent)
    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (!sessionId || questions.length === 0) return next()
    // Several questions (or a multi-select, which needs a checkbox form) become
    // ONE card with one form: answering them one card at a time is exactly the
    // chore the user asked to avoid.
    if (questions.length > 1 || questions[0]?.multiSelect === true) {
      return onQuestionBatch(sessionId, questions, next)
    }

    const answers = new Map()
    const records = []
    let settled = false
    let resolveBatch
    const batch = new Promise(resolve => { resolveBatch = resolve })
    const finishBatch = value => {
      if (settled) return
      settled = true
      for (const record of records) untrackPending(record)
      resolveBatch(value)
    }
    const maybeFinish = () => {
      if (answers.size < questions.length) return
      finishBatch({ answers: questions.map(question => answers.get(question.id) ?? { id: question.id, selected: [] }) })
    }

    let delivered = 0
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index]
      const record = {
        key: `question:${question.id}:${randomUUID()}`,
        kind: 'question',
        sessionId,
        question,
        done: false,
      }
      record.view = questionView(record, question, index, questions.length)
      record.apply = (answer, note) => {
        if (record.done) return
        record.done = true
        answers.set(question.id, answer)
        untrackPending(record)
        guard(paintPromptResult(record, 'answered', note), 'prompt paint')
        maybeFinish()
      }
      records.push(record)
      try {
        const sent = await postCard({
          sessionId,
          card: buildCard(record.view),
          idempotencyKey: `dsh-q-${randomUUID().slice(0, 24)}`,
        })
        if (sent?.messageId) {
          record.messageId = sent.messageId
          trackPending(record)
          delivered += 1
        }
      } catch (error) {
        debugLog(`question card failed session=${sessionId}: ${String(error?.message || error).slice(0, 200)}`)
      }
    }

    if (delivered === 0) {
      for (const record of records) untrackPending(record)
      return next()
    }
    if (CONFIG.feishuOnly) return batch

    const ui = Promise.resolve().then(() => next()).catch(() => null)
    ui.then(value => {
      if (value && Array.isArray(value.answers)) finishBatch(value)
    })
    return batch
  }

  ctx.on('approval/request', (request, next) => onApprovalRequest(request, next).catch(error => {
    debugLog(`approval handler failed: ${error?.message || error}`)
    return next()
  }), { prepend: true })

  ctx.on('user-questions/request', (request, next) => onQuestionsRequest(request, next).catch(error => {
    debugLog(`questions handler failed: ${error?.message || error}`)
    return next()
  }), { prepend: true })

  // ── text replies, commands, card callbacks ───────────────────────────────

  function normalizeIncomingText(value) {
    let text = String(value ?? '').trim()
    const fenced = text.match(/^```(?:text|plaintext)?\s*\r?\n([\s\S]*?)\r?\n```$/i)
    if (fenced) text = fenced[1].trim()
    return text.replace(/^`(?:text|plaintext)`\s*\r?\n/i, '').trim()
  }

  function parseApprovalReply(value) {
    const raw = String(value ?? '').trim()
    if (!raw) return null
    if (/^(取消|\/cancel|cancel|放弃)$/i.test(raw)) return 'cancel'
    if (/^(1|同意|允许|批准|可以|好|y|yes|ok)$/i.test(raw)) return 'allow'
    if (/^(2|拒绝|不行|不允许|不同意|n|no)$/i.test(raw)) return 'deny'
    return null
  }

  function parseQuestionReply(value, question) {
    const raw = String(value ?? '').trim()
    if (!raw) return null
    if (/^(取消|\/cancel|cancel|跳过|skip)$/i.test(raw)) return { cancel: true }
    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length === 0) return { selected: [], custom: raw }
    const parts = raw.split(/[,，、\s]+/).map(part => part.replace(/[.。、)）]$/, '')).filter(Boolean)
    const picked = []
    for (const part of parts) {
      if (!/^\d+$/.test(part)) { picked.length = 0; break }
      const index = Number(part)
      const label = options[index - 1]?.label
      if (typeof label !== 'string') { picked.length = 0; break }
      picked.push(label)
    }
    if (picked.length === 0) return { selected: [], custom: raw }
    return { selected: question?.multiSelect === true ? picked : [picked[0]] }
  }

  function replyParentId(event) {
    return String(event?.reply_to || event?.root_id || '').trim()
  }

  function code(value) {
    return `\`${String(value ?? '').replace(/`/g, "'")}\``
  }

  function workspaceEntries() {
    const list = services.workspaceRegistry?.list?.() || []
    return list
      .filter(workspace => typeof workspace?.path === 'string' && workspace.path.trim())
      .map(workspace => {
        const path = workspace.path.trim()
        const name = basename(path.replace(/[\\/]+$/, ''))
        const aliases = [workspace.id, workspace.name, workspace.title, name]
          .filter(value => typeof value === 'string' && value.trim())
          .map(value => value.trim().toLowerCase())
        return { workspace, path, aliases: [...new Set(aliases)], label: workspace.title || workspace.name || name || path }
      })
  }

  function resolveWorkspace(alias) {
    const wanted = String(alias || '').trim().toLowerCase()
    return workspaceEntries().find(entry => entry.aliases.includes(wanted)) || null
  }

  async function createAgentRequest(sessionId, cwd) {
    const request = { sessionId, meta: { cwd } }
    try {
      const picked = services.agentDefaultModel?.currentSelection?.()
      if (typeof picked?.provider === 'string' && typeof picked?.model === 'string') {
        request.agentOptions = { provider: picked.provider, model: picked.model }
        if (picked.reasoningEffort !== undefined) request.agentOptions.reasoningEffort = picked.reasoningEffort
      }
    } catch { /* host decides */ }
    try {
      const presets = services.agentPresets
      if (presets?.resolve && presets?.mount) {
        const resolved = await presets.resolve(undefined)
        if (resolved?.id) {
          request.preset = resolved.id
          request.setup = async agentCtx => { await presets.mount(agentCtx, resolved.id) }
        }
      }
    } catch { /* host decides */ }
    return request
  }

  async function sendCommandCard(event, view) {
    const messageId = String(event?.message_id || event?.id || '')
    const authorized = await ensureUser()
    const sent = await lark.sendCard({
      openId: authorized.openId,
      chatId: String(event?.chat_id || ''),
      rootId: messageId && CONFIG.thread ? messageId : '',
      card: buildCard(view),
      idempotencyKey: `dsh-cmd-${randomUUID().slice(0, 24)}`,
    })
    if (sent.messageId) {
      bindings.messages[sent.messageId] = { sessionId: '', chatId: sent.chatId, kind: 'command', createdAt: Date.now() }
      saveBindings(bindings)
    }
    return sent
  }

  async function handleDshCommand(event, command) {
    if (command.kind === 'workspaces') {
      const entries = workspaceEntries()
      await sendCommandCard(event, {
        title: 'DSH 工作区',
        subtitle: `${entries.length} 个可用工作区`,
        status: 'done',
        answer: entries.length
          ? entries.map(entry => `- **${entry.label}** → ${code(entry.path)}`).join('\n')
          : '还没有添加工作区。',
        hint: '新建会话：/dsh new --workspace <别名> <任务>',
      })
      return
    }
    if (command.kind === 'sessions') {
      const rows = Object.values(bindings.sessions)
        .filter(item => item?.sessionId)
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      const lines = rows.slice(0, 20).map(item => {
        const name = clip(item.sessionTitle || item.chatTitle || item.sessionId.slice(-6), 40)
        return item.chatLink
          ? `- **${name}** → [打开会话](${item.chatLink})`
          : `- **${name}**（尚未建群）`
      })
      await sendCommandCard(event, {
        title: 'DSH 会话映射',
        subtitle: `${rows.length} 个会话 · 1 会话 = 1 飞书群`,
        status: 'done',
        answer: lines.join('\n') || '还没有会话。',
        hint: '点「打开会话」进入对应的飞书群；在那个群里直接说话即可继续该 DSH 会话。',
      })
      return
    }
    if (command.kind === 'doctor') {
      const status = await lark.authStatus()
      const stats = bindings.stats || {}
      const callbackHint = stats.cardCallbacks
        ? `已收到 ${stats.cardCallbacks} 次卡片交互`
        : '尚未收到卡片交互（按钮若无效，请在飞书开放平台开启「回调配置」）'
      await sendCommandCard(event, {
        title: 'DSH 飞书卡片诊断',
        subtitle: '运行状态自查',
        status: 'done',
        fields: [
          { label: '机器人', value: String(status?.identities?.bot?.status || '未知') },
          { label: '用户', value: String(status?.identities?.user?.status || '未知') },
          { label: '卡片交互', value: callbackHint, wide: true },
          { label: '会话绑定', value: String(Object.keys(bindings.sessions).length) },
        ],
        answer: `配置：${code(CONFIG.path)}\n状态：${code(String(bindings.stats?.lastCallbackAt ? new Date(bindings.stats.lastCallbackAt).toLocaleString('zh-CN') : '—'))}`,
      })
      return
    }
    if (command.kind === 'approvalTest') {
      // A real pending record with the same repaint path as a live approval, so
      // "click → disabled buttons → state changes" can be verified on demand.
      const authorized = await ensureUser()
      const sessionId = sessionIdOf(ctx.agents?.current) || ''
      const record = {
        key: `approval:test-${randomUUID()}`,
        kind: 'approval',
        sessionId,
        sessionTitle: '审批流程自检',
        done: false,
        request: {
          toolName: 'pwsh',
          reason: '这是一条自检请求，不会真的执行任何命令；点「允许一次」只用来验证卡片状态会更新。',
        },
      }
      record.view = approvalView(record, record.request)
      const sent = await postCard({
        sessionId: sessionId || 'approval-test',
        card: buildCard(record.view),
        idempotencyKey: `dsh-apptest-${record.key.slice(-12)}`,
        chatId: String(event?.chat_id || ''),
      })
      if (!sent?.messageId) return
      record.messageId = sent.messageId
      record.resolve = () => { debugLog(`approval test resolved key=${record.key}`) }
      trackPending(record)
      void authorized
      return
    }

    if (command.kind === 'preview') {
      await sendCommandCard(event, {
        title: 'DeepSeek Harness · 卡片预览',
        subtitle: 'demo · 现在',
        status: 'done',
        activity: '',
        answer: '**这是一张 DSH 卡片**\n\n- 正文支持 Markdown、代码与表格\n- 执行过程收进折叠面板\n- 底部展示本轮统计',
        timeline: [
          { name: 'pwsh', summary: 'git status --short', state: 'done', durationMs: 1240 },
          { name: 'grep', summary: 'streaming', state: 'done', durationMs: 320 },
        ],
        toolDurationMs: 1560,
        meta: { model: 'deepseek-flash', durationMs: 4200, inputTokens: 1820, outputTokens: 640, contextPercent: 3 },
        hint: '这是一条命令触发的预览卡片。',
      })
      return
    }
    if (command.kind === 'help') {
      await sendCommandCard(event, {
        title: 'DSH 飞书命令',
        subtitle: '控制台',
        status: 'done',
        answer: [
          '- `/dsh workspaces`：列出可用工作区',
          '- `/dsh new --workspace <别名> <任务>`：在指定工作区新建会话',
          '- `/dsh doctor`：检查卡片与事件通道',
          '- `/dsh preview`：发送一张预览卡片',
        ].join('\n'),
        hint: '普通消息请直接回复已有 DSH 卡片。',
      })
      return
    }

    const entry = resolveWorkspace(command.workspace)
    if (!entry) {
      const names = workspaceEntries().map(item => `**${item.label}**`).join('、') || '（无）'
      await sendCommandCard(event, {
        title: '找不到工作区',
        subtitle: command.workspace,
        status: 'error',
        answer: `可用别名：${names}`,
      })
      return
    }
    if (!command.task) {
      await sendCommandCard(event, {
        title: '需要任务内容',
        subtitle: command.workspace,
        status: 'error',
        answer: '例如：`/dsh new --workspace demo 修复登录测试`',
      })
      return
    }
    if (!ctx.agents?.create) {
      await sendCommandCard(event, { title: '无法创建会话', status: 'error', answer: '当前 DSH Host 不支持创建新会话。' })
      return
    }

    const sessionId = `session-${randomUUID()}`
    const created = await ctx.agents.create(await createAgentRequest(sessionId, entry.path))
    const agent = created?.agent
    if (!agent?.followup) throw new Error('新会话 Agent 不可用')
    try {
      const workspace = workspaceEntries().find(item => item.path === entry.path)?.workspace
      if (workspace?.attachSession) await workspace.attachSession(agent.id)
    } catch (error) {
      debugLog(`workspace attach failed: ${error?.message || error}`)
    }
    const boundId = String(agent.id || sessionId)
    const session = bindingsFor(boundId)
    session.chatId = String(event?.chat_id || '')
    session.sessionTitle = entry.label
    session.cwd = entry.path
    session.updatedAt = Date.now()
    const sent = await postCard({
      sessionId: boundId,
      asRoot: true,
      chatId: String(event?.chat_id || ''),
      card: buildCard({
        title: `新会话 · ${entry.label}`,
        subtitle: '已就绪',
        status: 'done',
        fields: [{ label: '工作区', value: code(entry.path) }],
        answer: `**任务**\n${clip(command.task, 400)}`,
        hint: '后续输出会继续发送到本话题。',
      }),
      idempotencyKey: `dsh-new-${boundId.slice(-12)}`,
    })
    session.rootMessageId = sent.messageId
    session.rootVerified = true
    saveBindings(bindings)
    agent.followup({
      id: randomUUID(),
      role: 'user',
      source: { kind: 'feishu-new', chatId: event.chat_id, messageId: event.message_id || event.id, workspace: entry.path, at: Date.now() },
      content: [{ type: 'text', text: command.task }],
    })
    debugLog(`session created session=${boundId} cwd=${entry.path}`)
  }

  function parseDshCommand(value) {
    // Slash commands are registered as `/dsh-sessions` etc. and arrive as that
    // literal text, so normalize them to the space-separated form.
    const normalized = normalizeIncomingText(value)
      .replace(/^\/dsh-(sessions?|workspaces?|doctor|preview|test|new)\b/i, (_match, sub) => `/dsh ${sub}`)
    const text = normalized
    if (!/^\/dsh(?:\s|$)/i.test(text)) return null
    const rest = text.replace(/^\/dsh\s*/i, '').trim()
    if (/^workspaces?$/i.test(rest) || /^ls(?:\s+workspaces?)?$/i.test(rest)) return { kind: 'workspaces' }
    if (/^doctor$/i.test(rest)) return { kind: 'doctor' }
    if (/^sessions?$/i.test(rest)) return { kind: 'sessions' }
    if (/^(preview|test)$/i.test(rest)) return { kind: 'preview' }
    if (/^approval(?:-test|s-test)?$/i.test(rest)) return { kind: 'approvalTest' }
    const match = rest.match(/^new\s+--workspace(?:=|\s+)([^\s]+)(?:\s+([\s\S]+))?$/i)
    if (match) return { kind: 'new', workspace: match[1], task: (match[2] || '').trim() }
    return { kind: 'help' }
  }

  /** Resolve a pending prompt from a text reply. Returns true when consumed. */
  async function answerPendingFromText(parentId, sessionId, text) {
    let record = pendingKeyOf(parentId)
    if (!record) {
      const open = [...(openBySession.get(sessionId) || [])].map(key => pendings.get(key)).filter(item => item && !item.done)
      if (open.length === 1) record = open[0]
      else if (open.length > 1) {
        // Ambiguous: several prompts are waiting, so do not guess which one the
        // text answers. Consume the reply and ask for a direct reply instead.
        return true
      }
    }
    if (!record || record.done) return false

    if (record.kind === 'approval') {
      const verdict = parseApprovalReply(text)
      if (!verdict) return false
      if (verdict === 'allow') guard(answerPending(record, 'allowed-once', '已允许本次调用。'), 'text answer')
      else if (verdict === 'deny') guard(answerPending(record, 'rejected', '已拒绝本次调用。'), 'text answer')
      else guard(answerPending(record, 'cancelled', '已取消。'), 'text answer')
      return true
    }

    const parsed = parseQuestionReply(text, record.question)
    if (!parsed) return true
    if (parsed.cancel) {
      record.apply({ id: record.question.id, selected: [] }, '已跳过这个问题。')
      return true
    }
    const answer = { id: record.question.id, selected: parsed.selected }
    if (parsed.custom !== undefined) answer.custom = parsed.custom
    record.apply(answer, `已记录：${parsed.custom ?? parsed.selected.join('、')}`)
    return true
  }

  async function routeIncoming(event) {
    if (disposed) return
    const incomingId = String(event?.message_id || event?.id || '').trim()
    if (incomingId && bindings.handledIncoming[incomingId]) return
    const authorized = await ensureUser()
    if (event?.sender_type === 'bot' || event?.sender_id !== authorized.openId) return

    const markHandled = () => {
      if (!incomingId) return
      bindings.handledIncoming[incomingId] = Date.now()
      saveBindings(bindings)
    }

    const command = parseDshCommand(event?.content)
    if (command) {
      try {
        await handleDshCommand(event, command)
      } catch (error) {
        debugLog(`command failed: ${error?.message || error}`)
        await sendCommandCard(event, { title: '命令执行失败', status: 'error', answer: String(error?.message || error) }).catch(() => {})
      }
      markHandled()
      return
    }

    const parentId = replyParentId(event)
    let binding = parentId ? bindings.messages[parentId] : undefined
    if (!binding?.sessionId) {
      // A session-owned chat maps every message in it to that one session.
      const mapped = bindings.chats?.[String(event?.chat_id || '')]
      if (mapped) binding = { sessionId: mapped }
    }
    if (!binding?.sessionId) {
      // A plain message (no reply target) is the normal thing to type after
      // reading a card. Route it to the most recently active session bound to
      // this chat so the user is not forced to hunt for "回复".
      const candidates = Object.values(bindings.sessions)
        .filter(session => session?.sessionId && session.chatId && session.chatId === String(event?.chat_id || ''))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      if (candidates.length > 0) {
        binding = { sessionId: candidates[0].sessionId }
        debugLog(`plain message routed to most recent session=${binding.sessionId} (${candidates.length} bound to chat)`)
      }
    }
    if (!binding?.sessionId) return
    const text = normalizeIncomingText(event?.content)
    if (!text) return

    if (await answerPendingFromText(parentId, binding.sessionId, text)) {
      markHandled()
      return
    }

    const session = bindingsFor(binding.sessionId)
    if (!session.rootMessageId && parentId) {
      session.rootMessageId = String(event.root_id || parentId)
      saveBindings(bindings)
    }

    let agent = ctx.agents?.get?.(binding.sessionId)
    if (!agent && ctx.agents?.resume) {
      try {
        agent = (await ctx.agents.resume({ resumeSessionId: binding.sessionId })).agent
      } catch (error) {
        debugLog(`resume failed session=${binding.sessionId}: ${error?.message || error}`)
        return
      }
    }
    if (!agent?.followup) {
      debugLog(`session unavailable session=${binding.sessionId}`)
      return
    }
    const message = {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'feishu', chatId: event.chat_id, messageId: incomingId, replyTo: parentId, at: Date.now() },
      content: [{ type: 'text', text }],
    }
    let steered = false
    if ((runningSessions.has(binding.sessionId) || agent.status === 'running') && typeof agent.steer === 'function') {
      try { agent.steer(message); steered = true } catch { steered = false }
    }
    if (!steered) agent.followup(message)
    debugLog(`routed reply session=${binding.sessionId} delivery=${steered ? 'steer' : 'followup'} chars=${text.length}`)
    markHandled()
  }

  /**
   * Bot menu click (`application.bot.menu_v6`).
   *
   * Menu items are configured in the developer console; each carries a
   * developer-defined `event_key` that maps onto the same commands as the
   * text `/dsh ...` form.
   */
  async function onBotMenu(event) {
    try {
      const authorized = await ensureUser()
      if (event?.operator_open_id && event.operator_open_id !== authorized.openId) return
      const key = String(event?.event_key || '')
      const command = MENU_COMMANDS[key]
      if (!command) {
        debugLog(`bot menu unknown event_key=${key}`)
        return
      }
      debugLog(`bot menu ${key}`)
      await handleDshCommand({ chat_id: '', message_id: '', id: `menu-${Date.now()}` }, command)
    } catch (error) {
      debugLog(`bot menu failed: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
  }

  async function onCardAction(event) {
    if (disposed) return
    try {
      // Ground truth for every interaction: what Feishu actually delivered.
      debugLog(`card action tag=${event?.action_tag || ''} name=${event?.action_name || ''} option=${JSON.stringify(event?.option ?? null)} options=${JSON.stringify(event?.options ?? null)} checked=${JSON.stringify(event?.checked ?? null)} form=${String(event?.form_value ?? '').slice(0, 400)} value=${String(event?.action_value ?? '').slice(0, 200)}`)
      const authorized = await ensureUser()
      if (event?.operator_id && event.operator_id !== authorized.openId) return

      // A form submit reports its fields in `form_value` and carries no
      // `action_value`, so resolve it by the message the form lives in.
      const formRaw = event?.form_value
      if (typeof formRaw === 'string' && formRaw.trim()) {
        let fields = {}
        try { fields = JSON.parse(formRaw) } catch { fields = {} }
        const custom = String(fields?.custom ?? '').trim()
        // A dropdown reports `selection`: a value (single) or an array (multi).
        const rawSelection = fields?.selection
        const labels = splitSelection(rawSelection)
        const formRecord = pendingKeyOf(String(event?.message_id || ''))
        if (formRecord && formRecord.kind === 'batch') {
          const answers = formRecord.questions.map((question, index) => {
            const options = Array.isArray(question?.options) ? question.options : []
            let selected = []
            if (useCheckers(question)) {
              // Checkbox list: each option reports its own boolean field.
              selected = options
                .map((option, optionIndex) => {
                  const flag = fields?.[`q${index}_${optionIndex}`]
                  return flag === true || flag === 'true' ? clip(option.label, 60) : ''
                })
                .filter(Boolean)
            } else {
              const raw = fields?.[`q${index}`]
              selected = splitSelection(raw)
              // The change callback carries the complete multi-selection; the
              // form submit truncates it to one value.
              const cached = formRecord.multiSelections?.get(index)
              if (question?.multiSelect === true && Array.isArray(cached) && cached.length > 0) {
                selected = cached
              }
            }
            const custom = String(fields?.[`q${index}_custom`] ?? '').trim()
            const answer = { id: question.id, selected }
            if (custom) answer.custom = custom
            return answer
          })
          const answered = answers.filter(answer => answer.selected.length > 0 || answer.custom)
          if (answered.length > 0) {
            bindings.stats.cardCallbacks = Number(bindings.stats.cardCallbacks || 0) + 1
            bindings.stats.lastCallbackAt = Date.now()
            saveBindings(bindings)
            formRecord.applyBatch(answers, `已记录 ${answered.length}/${answers.length} 题`)
            return
          }
          debugLog('batch form submitted empty')
          return
        }
        if (formRecord && formRecord.kind === 'question' && (labels.length > 0 || custom)) {
          bindings.stats.cardCallbacks = Number(bindings.stats.cardCallbacks || 0) + 1
          bindings.stats.lastCallbackAt = Date.now()
          saveBindings(bindings)
          const answer = { id: formRecord.question.id, selected: labels }
          if (custom) answer.custom = custom
          formRecord.apply(answer, `已记录：${custom || labels.join('、')}`)
          return
        }
        debugLog(`form submit ignored (no pending question): labels=${labels.length} custom=${custom.length}`)
        return
      }

      let value = event?.action_value
      if (typeof value === 'string') {
        try { value = JSON.parse(value) } catch { value = null }
      }
      if (!value || typeof value !== 'object') {
        debugLog(`card action without value tag=${event?.action_tag || ''}`)
        return
      }
      bindings.stats.cardCallbacks = Number(bindings.stats.cardCallbacks || 0) + 1
      bindings.stats.lastCallbackAt = Date.now()
      saveBindings(bindings)

      if (value.k === 'stop') {
        const agent = ctx.agents?.get?.(String(value.s || ''))
        if (agent?.cancel) {
          agent.cancel({ kind: 'user' })
          debugLog(`stop requested session=${value.s} turn=${value.t}`)
        }
        return
      }

      if (value.k === 'multi') {
        // A multi-select reports the whole set on every change; remember it so
        // the eventual form submit does not truncate the answer.
        const multiRecord = pendings.get(String(value.id || ''))
        if (multiRecord && !multiRecord.done) {
          const labels = String(event?.options || '')
            .split(/[,，]/)
            .map(item => item.trim())
            .filter(Boolean)
          if (labels.length > 0) {
            multiRecord.multiSelections ||= new Map()
            multiRecord.multiSelections.set(Number(value.i), labels)
            debugLog(`multi selection q${value.i}: ${labels.join('、')}`)
          }
        }
        return
      }

      if (value.k === 'approve-all' || value.k === 'trust') {
        await resolveAllApprovals(String(value.s || ''), value.k === 'trust')
        return
      }
      const record = pendings.get(String(value.id || ''))
      if (!record || record.done) {
        debugLog(`card action for unknown pending id=${value.id}`)
        return
      }
      if (value.k === 'approve') {
        if (value.v === 'allow') guard(answerPending(record, 'allowed-once', '已允许本次调用。'), 'card answer')
        else if (value.v === 'deny') guard(answerPending(record, 'rejected', '已拒绝本次调用。'), 'card answer')
        else guard(answerPending(record, 'cancelled', '已取消。'), 'card answer')
        return
      }
      if (value.k === 'answer') {
        const index = Number(value.i)
        const option = record.question?.options?.[index]
        if (!option) return
        record.apply({ id: record.question.id, selected: [option.label] }, `已选择：${option.label}`)
      }
    } catch (error) {
      debugLog(`card action failed: ${error?.message || error}`)
    }
  }

  async function startConsumers() {
    // Adopt the event bus: a leaked consumer from an earlier generation would
    // otherwise answer every incoming Feishu message a second time.
    try {
      const stale = await lark.stopForeignConsumers(['im.message.receive_v1', 'card.action.trigger'])
      if (stale) debugLog(`adopted event bus: stopped ${stale} stale consumer(s)`)
    } catch { /* status unavailable: just start normally */ }
    const attempts = new Map()
    const start = (key, handler) => {
      let stopped = false
      const child = lark.startConsumer(key, value => { guard(handler(value), 'consumer event') }, {
        onLog: message => debugLog(`${key}: ${message}`),
        onExit: ({ stderr }) => {
          if (disposed || stopped) return
          // A missing console subscription is a configuration fact, not a
          // transient failure: keep the text-reply path working and stop
          // respawning a consumer that can never deliver.
          if (/requires callbacks not subscribed|requires events not subscribed|not subscribed in console|not subscribed/i.test(stderr)) {
            stopped = true
            bindings.stats.cardActionsUnavailable = true
            saveBindings(bindings)
            debugLog(`${key}: 飞书开放平台未订阅该回调，按钮不可用（文字回复仍有效）`)
            return
          }
          const count = Number(attempts.get(key) || 0) + 1
          attempts.set(key, count)
          // Never give up on the message stream: DSH must keep receiving Feishu
          // replies for as long as it runs. Back off to a steady 30s instead.
          const delay = Math.min(30_000, 1500 * Math.min(count, 20))
          debugLog(`${key}: restart #${count} in ${delay}ms`)
          const timer = setTimeout(() => { timers.delete(timer); start(key, handler) }, delay)
          timer.unref?.()
          timers.add(timer)
        },
      })
      children.push(child)
      // The event bus only rejects an unsubscribed callback at consume time.
      // If the card consumer survives its first seconds, interactions work and
      // cards may show buttons; otherwise they degrade to numbered text.
      if (key === 'card.action.trigger') {
        const probe = setTimeout(() => {
          timers.delete(probe)
          if (disposed || stopped) return
          if (bindings.stats.cardActionsUnavailable !== false) {
            bindings.stats.cardActionsUnavailable = false
            saveBindings(bindings)
            debugLog('card.action.trigger: live, card buttons enabled')
          }
        }, 8000)
        probe.unref?.()
        timers.add(probe)
      }
      return child
    }
    start('im.message.receive_v1', event => routeIncoming(event))
    start('card.action.trigger', event => onCardAction(event))
    start('application.bot.menu_v6', event => onBotMenu(event))
  }

  /**
   * Recover a turn whose `turn/end` never reached the plugin (app shutdown).
   * Only sessions this bridge already owns are touched, and a missing baseline
   * is recorded instead of re-sending history.
   */
  async function catchUpMissedTurns() {
    if (!CONFIG.catchUp) return
    let agents
    try { agents = ctx.agents?.list?.() } catch { return }
    if (!Array.isArray(agents) || agents.length === 0) return
    const authorized = await ensureUser().catch(() => null)
    if (!authorized) return
    for (const agent of agents) {
      const sessionId = sessionIdOf(agent)
      if (!sessionId || runningSessions.has(sessionId)) continue
      const session = bindings.sessions[sessionId]
      if (!session) continue
      let text = ''
      try {
        const messages = agent.session?.deriveMessages?.() || []
        for (const message of messages.slice().reverse()) {
          if (message?.role !== 'assistant') continue
          const candidate = textOf(message.content)
          if (candidate) { text = candidate; break }
        }
      } catch { continue }
      if (!text) continue
      const hash = hashOf(text)
      if (!session.lastSentHash) {
        session.lastSentHash = hash
        saveBindings(bindings)
        continue
      }
      if (session.lastSentHash === hash) continue
      try {
        const sent = await lark.sendMarkdown({
          openId: authorized.openId,
          chatId: session.chatId,
          rootId: CONFIG.thread ? session.rootMessageId : '',
          markdown: `**${session.sessionTitle || 'DeepSeek Harness'}**\n\n${text}`,
          idempotencyKey: `dsh-catchup-${sessionId.slice(-10)}-${Date.now()}`,
        })
        if (sent.messageId) {
          bindings.messages[sent.messageId] = { sessionId, chatId: session.chatId, kind: 'card', createdAt: Date.now() }
        }
        session.lastSentHash = hash
        saveBindings(bindings)
        debugLog(`catch-up sent session=${sessionId} chars=${text.length}`)
      } catch (error) {
        debugLog(`catch-up failed session=${sessionId}: ${String(error?.message || error).slice(0, 200)}`)
      }
    }
  }

  ctx.on('dispose', () => {
    disposed = true
    for (const turn of turns.values()) stopPump(turn)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const child of children) lark.stopConsumer(child)
  })

  /**
   * Opt-in end-to-end self test: with `~/.dsh/feishu-card-selftest.flag`
   * present at mount time, start one real session so the whole card pipeline
   * (create → stream patches → finalize) runs against Feishu. The flag is
   * consumed, so this never repeats by accident.
   */
  async function maybeRunSelfTest() {
    const flag = join(HOME, 'feishu-card-selftest.flag')
    if (!existsSync(flag)) return
    try { unlinkSync(flag) } catch { /* best effort */ }
    if (!ctx.agents?.create) return
    const cwd = services.workingDirectory?.defaultDirectory || process.cwd()
    const sessionId = `session-${randomUUID()}`
    const created = await ctx.agents.create(await createAgentRequest(sessionId, cwd))
    const agent = created?.agent
    if (!agent?.followup) throw new Error('自检会话创建失败')
    bindingsFor(String(agent.id || sessionId)).sessionTitle = '卡片自检'
    saveBindings(bindings)
    debugLog(`self-test session=${agent.id} created`)
    agent.followup({
      id: randomUUID(),
      role: 'user',
      source: { kind: 'feishu-selftest', at: Date.now() },
      content: [{
        type: 'text',
        text: '先运行一次 pwsh 命令 `Get-Date -Format o`，然后用三句话说明你能做什么，最后给一个 TypeScript 代码块（3 行即可）。不要使用其他工具。',
      }],
    })
  }

  void ensureUser()
    .then(async () => {
      await startConsumers()
      debugLog(`feishu-card ready cards=${CONFIG.cards} thread=${CONFIG.thread} interval=${CONFIG.intervalMs}ms user=${user?.name || user?.openId || ''}`)
      return maybeRunSelfTest()
    })
    .catch(error => debugLog(`feishu-card not started: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`))

  const catchUp = setTimeout(() => { timers.delete(catchUp); guard(catchUpMissedTurns(), 'catch-up') }, 8000)
  catchUp.unref?.()
  timers.add(catchUp)

  debugLog('feishu-card plugin applied')
}
