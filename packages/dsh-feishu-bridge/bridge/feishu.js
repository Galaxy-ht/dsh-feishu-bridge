/**
 * Direct Feishu OpenAPI transport.
 *
 * The lark-cli path costs about a second per call because every invocation
 * re-resolves credentials and opens a fresh request. Talking to open.feishu.cn
 * directly with a cached tenant token and a keep-alive agent costs 100-300ms,
 * which is what makes real streaming (and CardKit's typewriter mode) possible.
 *
 * Credentials live outside the plugin, in `~/.dsh/feishu-card.secret.json`
 * (`{ appId, appSecret }`), and are never logged.
 */
import fs from 'node:fs'
import https from 'node:https'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')
const SECRET_PATH = join(HOME, 'feishu-card.secret.json')
const CONFIG_PATH = join(HOME, 'feishu-card.json')

const agent = new https.Agent({ keepAlive: true, maxSockets: 8 })
const RETRYABLE_TOKEN_CODES = new Set([99991661, 99991663, 99991668, 99991677])

let credentials
let token = ''
let tokenExpiresAt = 0
let pendingToken

/** Read `appId`/`appSecret`, preferring the dedicated secret file. */
export function loadCredentials() {
  if (credentials !== undefined) return credentials
  credentials = null
  for (const file of [SECRET_PATH, CONFIG_PATH]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof parsed?.appId === 'string' && typeof parsed?.appSecret === 'string'
        && parsed.appId && parsed.appSecret) {
        credentials = { appId: parsed.appId, appSecret: parsed.appSecret, source: file }
        return credentials
      }
    } catch { /* try the next candidate */ }
  }
  return credentials
}

export function hasCredentials() {
  return Boolean(loadCredentials())
}

/** One HTTPS request against open.feishu.cn. */
function request(method, path, body, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path,
      method,
      agent,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout,
    }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = { code: -1, msg: text.slice(0, 300) } }
        resolve({ status: response.statusCode, ...parsed })
      })
    })
    req.on('timeout', () => req.destroy(new Error('feishu request timeout')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Fetch (and cache) a tenant access token. */
export async function tenantToken(force = false) {
  if (!force && token && Date.now() < tokenExpiresAt) return token
  if (pendingToken) return pendingToken
  const creds = loadCredentials()
  if (!creds) throw new Error('缺少 appId/appSecret：请写入 ~/.dsh/feishu-card.secret.json')
  pendingToken = (async () => {
    const res = await request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: creds.appId,
      app_secret: creds.appSecret,
    })
    if (res.code !== 0 || !res.tenant_access_token) {
      throw new Error(`tenant_access_token 获取失败：${res.code} ${res.msg || ''}`)
    }
    token = res.tenant_access_token
    tokenExpiresAt = Date.now() + Math.max(60, (Number(res.expire) || 7200) - 300) * 1000
    return token
  })()
  try {
    return await pendingToken
  } finally {
    pendingToken = undefined
  }
}

/**
 * Call one OpenAPI path, refreshing the token once when the server says it is
 * no longer valid (a long-lived plugin outlives a 2-hour token).
 */
export async function api(method, path, body, options) {
  await tenantToken()
  let res = await request(method, path, body, options)
  if (RETRYABLE_TOKEN_CODES.has(Number(res.code)) || res.status === 401) {
    await tenantToken(true)
    res = await request(method, path, body, options)
  }
  return res
}

function messageIdOf(res) {
  const id = res?.data?.message_id
  if (typeof id !== 'string' || !id) {
    throw new Error(`发送消息失败：${res?.code ?? '?'} ${res?.msg || ''}`.trim())
  }
  return id
}

/**
 * Send one interactive card as a normal message.
 *
 * `rootId` replies inside that topic (used when `thread` is on); otherwise the
 * card becomes a main-window message, which is the default.
 */
export async function sendCard({ openId, chatId, rootId, card, idempotencyKey }) {
  const content = JSON.stringify(card)
  if (rootId) {
    const res = await api('POST', `/open-apis/im/v1/messages/${rootId}/reply`, {
      msg_type: 'interactive',
      content,
      ...(idempotencyKey ? { uuid: String(idempotencyKey).slice(0, 40) } : {}),
    })
    return { messageId: messageIdOf(res), chatId: '' }
  }
  const receiveIdType = chatId ? 'chat_id' : 'open_id'
  const res = await api('POST', `/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    receive_id: chatId || openId,
    msg_type: 'interactive',
    content,
    ...(idempotencyKey ? { uuid: String(idempotencyKey).slice(0, 40) } : {}),
  })
  return { messageId: messageIdOf(res), chatId }
}

/** Replace a whole interactive message (non-streaming fallback). */
export async function patchCard(messageId, card) {
  return api('PATCH', `/open-apis/im/v1/messages/${messageId}`, { content: JSON.stringify(card) })
}

/** Send plain markdown through a text/post message. */
export async function sendMarkdown({ openId, chatId, rootId, markdown, idempotencyKey }) {
  const content = JSON.stringify({ text: markdown })
  const path = rootId
    ? `/open-apis/im/v1/messages/${rootId}/reply`
    : `/open-apis/im/v1/messages?receive_id_type=${chatId ? 'chat_id' : 'open_id'}`
  const body = rootId
    ? { msg_type: 'text', content, ...(idempotencyKey ? { uuid: String(idempotencyKey).slice(0, 40) } : {}) }
    : { receive_id: chatId || openId, msg_type: 'text', content, ...(idempotencyKey ? { uuid: String(idempotencyKey).slice(0, 40) } : {}) }
  const res = await api('POST', path, body)
  return { messageId: messageIdOf(res), chatId }
}

/**
 * Create a private group chat holding just this app and the given users.
 *
 * One chat per DSH session is what makes the mapping 1:1: every session gets
 * its own conversation instead of sharing one chat with topics.
 */
/**
 * Append components to a card entity.
 *
 * `elements` must be a JSON **string** (the API rejects an array) and every
 * component carries a developer-defined `element_id` so it can be updated or
 * deleted later. `sequence` orders writes per card and must strictly increase.
 */
export async function appendElements(cardId, elements, sequence) {
  return api('POST', `/open-apis/cardkit/v1/cards/${cardId}/elements`, {
    ...(typeof elements === 'string' ? { type: 'append', elements } : { type: 'append', elements: JSON.stringify(elements) }),
    sequence,
    uuid: `dsh-append-${sequence}-${Date.now()}`,
  })
}

/** Replace one component in place (`element` is likewise a JSON string). */
export async function updateElement(cardId, elementId, element, sequence) {
  return api('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}`, {
    element: typeof element === 'string' ? element : JSON.stringify(element),
    sequence,
    uuid: `dsh-elem-${sequence}-${Date.now()}`,
  })
}

/** Remove one component. `sequence` must travel in the body, not the query. */
export async function deleteElement(cardId, elementId, sequence) {
  return api('DELETE', `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}`, {
    sequence,
    uuid: `dsh-del-${sequence}-${Date.now()}`,
  })
}

/**
 * Create a private group chat holding just this app and the given users.
 *
 * One chat per DSH session is what makes the mapping 1:1: every session gets
 * its own conversation instead of sharing one chat with topics.
 */
export async function createChat({ name, description, openIds }) {
  const res = await api('POST', '/open-apis/im/v1/chats?user_id_type=open_id', {
    name: String(name || '').slice(0, 60),
    description: String(description || '').slice(0, 100),
    user_id_list: (openIds || []).filter(Boolean),
    chat_mode: 'group',
    chat_type: 'private',
  })
  const chatId = res?.data?.chat_id
  if (res.code !== 0 || !chatId) throw new Error(`创建会话群失败：${res.code} ${res.msg || ''}`.trim())
  return { chatId, name: res.data.name || name || '' }
}

/** Rename a chat (keeps the session title in sync). */
export async function renameChat(chatId, name) {
  return api('PUT', `/open-apis/im/v1/chats/${chatId}`, { name: String(name || '').slice(0, 60) })
}

// ── CardKit: card entities with native streaming ──────────────────────────

/** Create a card entity so its elements can be updated incrementally. */
export async function createCardEntity(card) {
  const res = await api('POST', '/open-apis/cardkit/v1/cards', {
    type: 'card_json',
    data: JSON.stringify(card),
  })
  const cardId = res?.data?.card_id
  if (res.code !== 0 || !cardId) throw new Error(`创建卡片实体失败：${res.code} ${res.msg || ''}`.trim())
  return String(cardId)
}

/** Send a message that references an existing card entity. */
export async function sendCardEntity({ openId, chatId, rootId, cardId, idempotencyKey }) {
  const content = JSON.stringify({ type: 'card', data: { card_id: String(cardId) } })
  const res = rootId
    ? await api('POST', `/open-apis/im/v1/messages/${rootId}/reply`, {
      msg_type: 'interactive', content,
      ...(idempotencyKey ? { uuid: String(idempotencyKey).slice(0, 40) } : {}),
    })
    : await api('POST', `/open-apis/im/v1/messages?receive_id_type=${chatId ? 'chat_id' : 'open_id'}`, {
      receive_id: chatId || openId,
      msg_type: 'interactive',
      content,
      ...(idempotencyKey ? { uuid: String(idempotencyKey).slice(0, 40) } : {}),
    })
  return { messageId: messageIdOf(res), chatId }
}

/**
 * Push a text element's content while the card is in streaming mode.
 *
 * The client renders each arrival with its own typewriter rhythm, so even a
 * 250ms cadence looks like continuous typing rather than stepping.
 */
export async function streamElement(cardId, elementId, content, sequence) {
  return api('PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, {
    content,
    sequence,
    uuid: sequenceUuid(cardId, elementId, sequence),
  })
}

/** Replace the whole card entity (used for the final, non-streaming layout). */
export async function updateCardEntity(cardId, card, sequence) {
  return api('PUT', `/open-apis/cardkit/v1/cards/${cardId}`, {
    card: { type: 'card_json', data: JSON.stringify(card) },
    sequence,
    uuid: sequenceUuid(cardId, 'full', sequence),
  })
}

/** Turn streaming mode on or off for a card entity. */
export async function setStreaming(cardId, enabled, sequence) {
  const settings = JSON.stringify({
    config: enabled
      ? {
        streaming_mode: true,
        streaming_config: {
          print_frequency_ms: { default: 35 },
          print_step: { default: 1 },
          print_strategy: 'fast',
        },
      }
      : { streaming_mode: false },
  })
  return api('PATCH', `/open-apis/cardkit/v1/cards/${cardId}/settings`, {
    settings,
    sequence,
    uuid: sequenceUuid(cardId, 'settings', sequence),
  })
}

/** Deterministic idempotency id: a retried identical write is a no-op. */
function sequenceUuid(cardId, elementId, sequence) {
  return `${cardId}-${elementId}-${sequence}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 50)
}
