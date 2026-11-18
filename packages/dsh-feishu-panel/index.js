/**
 * dsh-feishu-panel — Host half.
 *
 * Serves the settings page of the Feishu bridge. The page itself is a Client
 * module (`./client`); everything that needs the filesystem, a process, or a
 * credential lives here and is reached over three loopback-only routes:
 *
 *   GET  /feishu-panel/state   → { schema, config, status }
 *   POST /feishu-panel/config  → { patch } → merged config
 *   POST /feishu-panel/test    → send one test message through the bridge
 *
 * The panel never changes the bridge's behaviour: it only reads and writes the
 * same `feishu-card.json` the bridge reads at mount time. Settings therefore
 * take effect on the next DSH restart, exactly as if they were edited by hand.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const name = 'dsh-feishu-panel'
export const inject = ['webServer']

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')
const CONFIG_PATH = join(HOME, 'feishu-card.json')
const SECRET_PATH = join(HOME, 'feishu-card.secret.json')
const BINDINGS_PATH = join(HOME, 'feishu-card-bindings.json')
const LOG_PATH = join(HOME, 'feishu-card.log')
const ROUTE_PREFIX = '/feishu-panel'
const MAX_BODY = 64 * 1024

/**
 * Declarative settings schema.
 *
 * The page renders groups and fields straight from this list, so adding a
 * setting is a one-line change here — no Client code, no new React component.
 * `key` is a dot path into feishu-card.json.
 */
const SCHEMA = [
  {
    id: 'routing',
    title: { zh: '会话映射', en: 'Session mapping' },
    description: {
      zh: '决定一个 DSH 会话在飞书里长什么样：独立群、话题，还是平铺消息。',
      en: 'How a DSH session appears in Feishu: its own chat, a topic, or flat messages.',
    },
    fields: [
      {
        key: 'sessionChats', type: 'boolean', default: true,
        label: { zh: '每个会话独立飞书群', en: 'One Feishu chat per session' },
        help: {
          zh: '开启后每个 DSH 会话自动建一个只有你和机器人的群，卡片直接发在群里，不使用话题。',
          en: 'Creates a private chat per session; cards land there directly, no topics.',
        },
      },
      {
        key: 'thread', type: 'boolean', default: false,
        label: { zh: '话题模式（仅关闭独立群时生效）', en: 'Topic mode (only without per-session chats)' },
        help: {
          zh: '首张卡在主窗口，后续卡片回复进该话题。独立群开启时此项被忽略。',
          en: 'First card in the main window, later cards inside its topic. Ignored when per-session chats are on.',
        },
      },
      {
        key: 'feishuOnly', type: 'boolean', default: true,
        label: { zh: '审批与提问只在飞书出现', en: 'Approvals and questions only in Feishu' },
        help: {
          zh: '关闭后飞书与 DSH 桌面同时弹出，谁先答谁生效，另一边会留下未关闭的弹窗。',
          en: 'Off means Feishu and the desktop both ask; the first answer wins and the other dialog stays open.',
        },
      },
    ],
  },
  {
    id: 'stream',
    title: { zh: '流式与刷新', en: 'Streaming and refresh' },
    description: {
      zh: '控制卡片更新的频率与并发；关闭卡片则退回纯 Markdown 消息。',
      en: 'Card update frequency and concurrency; turning cards off falls back to plain Markdown.',
    },
    fields: [
      {
        key: 'cards', type: 'boolean', default: true,
        label: { zh: '使用互动卡片', en: 'Use interactive cards' },
      },
      {
        key: 'card.intervalMs', type: 'number', default: 350, min: 200, max: 5000, step: 50,
        label: { zh: '最小刷新间隔（毫秒）', en: 'Minimum refresh interval (ms)' },
        help: { zh: '理想值 250~400；过小会排队。', en: '250–400 works best; lower values queue up.' },
      },
      {
        key: 'card.maxInflight', type: 'number', default: 3, min: 1, max: 4, step: 1,
        label: { zh: '并发更新数', en: 'Concurrent updates' },
        help: {
          zh: '直连 + CardKit 下单路串行即可；退回 lark-cli 时调高可提速。',
          en: 'One is enough with the direct CardKit path; raise it only on the lark-cli fallback.',
        },
      },
      {
        key: 'card.widthMode', type: 'select', default: 'default',
        options: [
          { value: 'default', label: { zh: '默认（≤600px）', en: 'Default (≤600px)' } },
          { value: 'compact', label: { zh: '紧凑（400px）', en: 'Compact (400px)' } },
          { value: 'fill', label: { zh: '撑满', en: 'Fill' } },
        ],
        label: { zh: '卡片宽度', en: 'Card width' },
      },
    ],
  },
  {
    id: 'display',
    title: { zh: '展示内容', en: 'What the card shows' },
    description: { zh: '卡片上出现哪些信息。', en: 'Which parts appear on the card.' },
    fields: [
      { key: 'card.showTools', type: 'boolean', default: true, label: { zh: '执行过程面板', en: 'Process panel' } },
      { key: 'card.reasoningPreview', type: 'boolean', default: true, label: { zh: '运行中显示思考预览', en: 'Live reasoning preview' } },
      { key: 'card.showReasoning', type: 'boolean', default: false, label: { zh: '完成后保留思考过程', en: 'Keep reasoning after completion' } },
      { key: 'card.footer', type: 'boolean', default: true, label: { zh: '页脚统计（模型/用时/token）', en: 'Footer stats (model/time/tokens)' } },
      {
        key: 'card.multiSelectStyle', type: 'select', default: 'dropdown',
        options: [
          { value: 'dropdown', label: { zh: '下拉多选', en: 'Dropdown multi-select' } },
          { value: 'checker', label: { zh: '勾选框', en: 'Checkboxes' } },
        ],
        label: { zh: '多选样式', en: 'Multi-select style' },
      },
    ],
  },
  {
    id: 'advanced',
    title: { zh: '高级', en: 'Advanced' },
    description: { zh: '通常不需要修改。', en: 'Usually leave these alone.' },
    fields: [
      { key: 'card.firstUpdateMs', type: 'number', default: 150, min: 100, max: 3000, step: 50, label: { zh: '首次建卡延迟（毫秒）', en: 'First card delay (ms)' } },
      { key: 'card.maxCardBytes', type: 'number', default: 27000, min: 8000, max: 29000, step: 500, label: { zh: '单卡字节预算', en: 'Card byte budget' } },
      { key: 'card.catchUp', type: 'boolean', default: false, label: { zh: '启动时补发未送出的回答', en: 'Deliver missed answers on startup' } },
    ],
  },
]

// ── filesystem helpers ────────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readByPath(object, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), object)
}

function writeByPath(object, key, value) {
  const parts = key.split('.')
  let node = object
  for (const part of parts.slice(0, -1)) {
    if (node[part] == null || typeof node[part] !== 'object') node[part] = {}
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
}

/** Coerce one submitted value to the schema's type; undefined rejects it. */
function coerce(field, value) {
  if (field.type === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (field.type === 'number') {
    const number = Number(value)
    if (!Number.isFinite(number)) return undefined
    const min = field.min ?? Number.NEGATIVE_INFINITY
    const max = field.max ?? Number.POSITIVE_INFINITY
    return Math.min(Math.max(number, min), max)
  }
  if (field.type === 'select') {
    return (field.options || []).some(option => option.value === value) ? value : undefined
  }
  return undefined
}

// ── lark-cli probes ───────────────────────────────────────────────────────

function larkInvocation() {
  const appData = process.env.APPDATA
  const entry = appData ? join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js') : ''
  if (existsSync(entry)) {
    for (const directory of String(process.env.PATH || '').split(delimiter)) {
      if (!directory) continue
      const candidate = join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'node.exe' : 'node')
      if (existsSync(candidate)) return { file: candidate, prefix: [entry] }
    }
  }
  const cmd = appData ? join(appData, 'npm', 'lark-cli.cmd') : ''
  if (cmd && existsSync(cmd)) return { file: cmd, prefix: [] }
  return { file: process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli', prefix: [] }
}

async function larkJson(args, timeout = 20_000) {
  const invocation = larkInvocation()
  const { stdout } = await execFileAsync(invocation.file, [...invocation.prefix, ...args], {
    windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  })
  return JSON.parse(stdout)
}

let authCache = { at: 0, value: null }

async function authStatus() {
  if (Date.now() - authCache.at < 30_000) return authCache.value
  try {
    const value = await larkJson(['auth', 'status'])
    authCache = { at: Date.now(), value }
    return value
  } catch {
    authCache = { at: Date.now(), value: null }
    return null
  }
}

// ── authorization checks ──────────────────────────────────────────────────
//
// Two independent grants decide whether the bridge works:
//   • user scopes   — granted to your account through the device flow, so the
//                     panel can offer one-click repair (QR or browser);
//   • tenant scopes — granted to the app by a tenant admin in the console, so
//                     the panel can only deep-link to the approval page.
// The tenant side is probed by calling one read endpoint per capability and
// reading the scope Feishu names in the refusal.

/**
 * User scopes the bridge itself reaches for.
 *
 * Only scopes a user token can actually carry belong here: `im:message:send_as_bot`
 * and `cardkit:card:write` are app-level grants, requested in the console, so
 * listing them would offer a repair the device flow can never satisfy.
 */
const REQUIRED_USER_SCOPES = [
  'im:message',
  'im:message:readonly',
  'im:message:update',
  'im:resource',
  'im:chat:read',
  'im:chat:update',
  'im:chat:create_by_user',
]

/**
 * One read endpoint per tenant capability, chosen to be cheap and side-effect
 * free. Every entry is a GET with valid arguments, so a refusal can only mean
 * "scope missing" rather than "bad request".
 */
const TENANT_PROBES = [
  { capability: '云盘文件', path: '/open-apis/drive/v1/files?page_size=1' },
  { capability: '知识库空间', path: '/open-apis/wiki/v2/spaces?page_size=1' },
  { capability: '任务列表', path: '/open-apis/task/v2/tasks?page_size=1' },
  { capability: '会议室', path: '/open-apis/vc/v1/rooms?page_size=1' },
  { capability: '电子表格', path: '/open-apis/sheets/v3/spreadsheets/shtcn_probe' },
]

async function userScopes() {
  try {
    const value = await larkJson(['auth', 'scopes', '--json'], 30_000)
    return Array.isArray(value?.userScopes) ? value.userScopes : []
  } catch {
    return []
  }
}

/** Call one endpoint through lark-cli and surface the scope it names. */
async function tenantProbe(path) {
  const invocation = larkInvocation()
  try {
    await execFileAsync(invocation.file, [...invocation.prefix, 'api', 'GET', path], {
      windowsHide: true, timeout: 20_000, encoding: 'utf8', maxBuffer: 1024 * 1024,
    })
    return { ok: true }
  } catch (error) {
    const output = String(error?.stdout || '') + String(error?.stderr || '')
    const match = output.match(/One of the following scopes is required: \[([^\]]+)\]/)
    if (match) return { ok: false, scopes: match[1].split(',').map(item => item.trim()) }
    if (/no dept authority/i.test(output)) return { ok: false, message: '通讯录权限范围未开放' }
    return { ok: false, message: output.replace(/\s+/g, ' ').slice(0, 160) }
  }
}

let checkCache = { at: 0, value: null }

async function authorizationReport(force = false) {
  if (!force && checkCache.value && Date.now() - checkCache.at < 120_000) return checkCache.value
  const [granted, probes] = await Promise.all([
    userScopes(),
    Promise.all(TENANT_PROBES.map(async probe => ({ ...probe, result: await tenantProbe(probe.path) }))),
  ])
  const missingUser = REQUIRED_USER_SCOPES.filter(scope => !granted.includes(scope))
  // Only a refusal that names a scope is a real permission gap; anything else
  // (an unexpected validation error, a transient failure) stays out of the
  // "missing" list so the page never offers a repair that cannot help.
  const tenantMissing = probes
    .filter(probe => !probe.result.ok && Array.isArray(probe.result.scopes) && probe.result.scopes.length > 0)
    .map(probe => ({
      capability: probe.capability,
      scopes: probe.result.scopes,
      message: probe.result.message || '',
    }))
  const tenantScopes = [...new Set(tenantMissing.flatMap(item => item.scopes))]
  const value = {
    user: { granted: granted.length, required: REQUIRED_USER_SCOPES, missing: missingUser },
    tenant: { missing: tenantMissing, scopes: tenantScopes },
    checkedAt: Date.now(),
  }
  checkCache = { at: Date.now(), value }
  return value
}

/** Console deep link that pre-selects the tenant scopes still missing. */
function consoleAuthUrl(appId, scopes) {
  const query = scopes.length > 0 ? `?q=${scopes.join(',')}&op_from=openapi&token_type=tenant` : ''
  return `https://open.feishu.cn/app/${appId || 'cli_xxx'}/auth${query}`
}
//
// `lark-cli auth login --no-wait` starts an OAuth device flow and returns a
// verification URL; the same URL renders a QR that the Feishu mobile app can
// scan. A second process (`--device-code`) finishes the flow once the user
// approves, so the page only has to poll.

/** One pending authorization; cleared on success, cancel, or expiry. */
const login = {
  status: 'idle', // idle | pending | ok | error
  deviceCode: '',
  url: '',
  qrPath: '',
  expiresAt: 0,
  message: '',
  child: null,
}

function resetLogin(status, message = '') {
  if (login.child) { try { login.child.kill() } catch { /* already gone */ } }
  login.status = status
  login.message = message
  login.deviceCode = ''
  login.url = ''
  login.qrPath = ''
  login.expiresAt = 0
  login.child = null
}

async function renderQr(url) {
  const file = join(tmpdir(), `dsh-feishu-login-${Date.now()}.png`)
  const invocation = larkInvocation()
  await execFileAsync(invocation.file, [...invocation.prefix, 'auth', 'qrcode', url, '-o', file, '--size', '512'], {
    windowsHide: true, timeout: 30_000, encoding: 'utf8',
  })
  return file
}

/** Poll the device code in the background; the page reads `login.status`. */
function followDeviceCode(code, expiresInSeconds) {
  const invocation = larkInvocation()
  const child = spawn(invocation.file, [...invocation.prefix, 'auth', 'login', '--device-code', code, '--json'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  login.child = child
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const timer = setTimeout(() => {
    if (login.status !== 'pending') return
    resetLogin('error', '授权超时，请重新发起')
  }, Math.max(30, expiresInSeconds + 15) * 1000)
  child.on('exit', exitCode => {
    clearTimeout(timer)
    if (login.deviceCode !== code) return
    login.child = null
    if (exitCode === 0) {
      authCache.at = 0
      resetLogin('ok', '授权完成')
      void authStatus()
    } else {
      resetLogin('error', output.slice(-300).trim() || `授权进程退出码 ${exitCode}`)
    }
  })
  child.on('error', error => {
    clearTimeout(timer)
    resetLogin('error', String(error?.message || error))
  })
}

// ── status document ───────────────────────────────────────────────────────

function tailErrors(limit = 4) {
  try {
    const lines = readFileSync(LOG_PATH, 'utf8').trimEnd().split(/\r?\n/)
    return lines.filter(line => /fail|error|race/i.test(line)).slice(-limit)
  } catch {
    return []
  }
}

async function buildStatus() {
  const auth = await authStatus()
  const bindings = readJson(BINDINGS_PATH, {})
  const sessions = Object.values(bindings.sessions || {})
  const chats = Object.entries(bindings.chats || {})
  return {
    configPath: CONFIG_PATH,
    secretPath: SECRET_PATH,
    logPath: LOG_PATH,
    secretPresent: existsSync(SECRET_PATH),
    appId: auth?.appId || '',
    identity: {
      bot: auth?.identities?.bot?.status || 'unknown',
      user: auth?.identities?.user?.status || 'unknown',
      userName: auth?.identities?.user?.userName || '',
    },
    bindings: {
      sessions: sessions.length,
      chats: chats.length,
      callbacks: Number(bindings.stats?.cardCallbacks || 0),
      lastCallbackAt: Number(bindings.stats?.lastCallbackAt || 0) || null,
      cardActionsUnavailable: bindings.stats?.cardActionsUnavailable === true,
    },
    errors: tailErrors(),
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

/** Loopback only: this panel writes local files and sends Feishu messages. */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

// ── plugin ────────────────────────────────────────────────────────────────

/**
 * Register the three panel routes.
 * @param ctx - Host context providing `webServer`.
 */
export function apply(ctx) {
  const dispose = []
  const register = (path, handler) => {
    dispose.push(ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  register(`${ROUTE_PREFIX}/state`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    try {
      const config = readJson(CONFIG_PATH, {})
      const secret = readJson(SECRET_PATH, {})
      sendJson(res, 200, {
        schema: SCHEMA,
        config,
        status: await buildStatus(),
        credentials: { appId: secret.appId || '', hasSecret: typeof secret.appSecret === 'string' && secret.appSecret.length > 0 },
        login: { status: login.status, message: login.message, url: login.url, expiresAt: login.expiresAt },
      })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message || error) })
    }
  })

  // ── login: device flow (QR + browser) ──────────────────────────────────

  register(`${ROUTE_PREFIX}/checks`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    try {
      const report = await authorizationReport(String(req.url || '').includes('force=1'))
      const auth = await authStatus()
      sendJson(res, 200, {
        ...report,
        consoleUrl: consoleAuthUrl(auth?.appId || '', report.tenant.scopes),
      })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message || error) })
    }
  })

  register(`${ROUTE_PREFIX}/console/open`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    try {
      const body = await readBody(req)
      const url = String(body?.url || '')
      if (!/^https:\/\/open\.feishu\.cn\/app\//.test(url)) { sendJson(res, 400, { error: '只允许打开开放平台页面' }); return }
      const opener = process.platform === 'win32'
        ? { file: 'cmd.exe', args: ['/c', 'start', '', url] }
        : process.platform === 'darwin'
          ? { file: 'open', args: [url] }
          : { file: 'xdg-open', args: [url] }
      spawn(opener.file, opener.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message || error) })
    }
  })

  register(`${ROUTE_PREFIX}/login/start`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    try {
      const body = await readBody(req).catch(() => ({}))
      const scopes = Array.isArray(body?.scopes) ? body.scopes.filter(item => typeof item === 'string' && item) : []
      resetLogin('pending')
      const args = ['auth', 'login', '--no-wait', '--json']
      if (scopes.length > 0) args.push('--scope', scopes.join(' '))
      else args.push('--recommend')
      const result = await larkJson(args, 60_000)
      const url = String(result?.verification_url || '')
      const deviceCode = String(result?.device_code || '')
      if (!url || !deviceCode) throw new Error('未拿到授权链接，请检查 lark-cli 版本')
      const expiresIn = Number(result?.expires_in || 600)
      login.deviceCode = deviceCode
      login.url = url
      login.expiresAt = Date.now() + expiresIn * 1000
      login.qrPath = await renderQr(url).catch(() => '')
      followDeviceCode(deviceCode, expiresIn)
      sendJson(res, 200, { url, expiresAt: login.expiresAt, hasQr: Boolean(login.qrPath) })
    } catch (error) {
      resetLogin('error', String(error?.message || error))
      sendJson(res, 500, { error: String(error?.message || error).slice(0, 300) })
    }
  })

  register(`${ROUTE_PREFIX}/login/qr`, async (req, res) => {
    if (!isLoopback(req)) { res.writeHead(403); res.end(); return }
    try {
      if (!login.qrPath || !existsSync(login.qrPath)) { res.writeHead(404); res.end(); return }
      const bytes = readFileSync(login.qrPath)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': bytes.length })
      res.end(bytes)
    } catch {
      res.writeHead(500); res.end()
    }
  })

  register(`${ROUTE_PREFIX}/login/poll`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    sendJson(res, 200, {
      status: login.status,
      message: login.message,
      url: login.url,
      expiresAt: login.expiresAt,
      identity: (await buildStatus()).identity,
    })
  })

  register(`${ROUTE_PREFIX}/login/cancel`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    resetLogin('idle', '已取消')
    sendJson(res, 200, { ok: true })
  })

  register(`${ROUTE_PREFIX}/login/open`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    if (!login.url) { sendJson(res, 409, { error: '还没有待完成的授权' }); return }
    try {
      // Windows: hand the URL to the default browser. macOS/Linux fall back to
      // the platform opener; failures surface as a 500 for the page to copy the
      // link manually.
      const opener = process.platform === 'win32'
        ? { file: 'cmd.exe', args: ['/c', 'start', '', login.url] }
        : process.platform === 'darwin'
          ? { file: 'open', args: [login.url] }
          : { file: 'xdg-open', args: [login.url] }
      spawn(opener.file, opener.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message || error) })
    }
  })

  // ── bot credentials ────────────────────────────────────────────────────

  register(`${ROUTE_PREFIX}/credentials`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    try {
      const body = await readBody(req)
      const appId = String(body?.appId || '').trim()
      const appSecret = String(body?.appSecret || '')
      if (!/^cli_[a-z0-9]+$/i.test(appId)) { sendJson(res, 400, { error: 'App ID 形如 cli_xxx' }); return }
      if (appSecret.length < 16) { sendJson(res, 400, { error: 'App Secret 看起来不完整' }); return }
      writeJson(SECRET_PATH, { appId, appSecret })
      sendJson(res, 200, { ok: true, restartRequired: true })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message || error) })
    }
  })

  register(`${ROUTE_PREFIX}/config`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    try {
      const body = await readBody(req)
      const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : {}
      const config = readJson(CONFIG_PATH, {})
      const applied = {}
      for (const group of SCHEMA) {
        for (const field of group.fields) {
          if (!Object.hasOwn(patch, field.key)) continue
          const value = coerce(field, patch[field.key])
          if (value === undefined) continue
          writeByPath(config, field.key, value)
          applied[field.key] = value
        }
      }
      writeJson(CONFIG_PATH, config)
      sendJson(res, 200, { applied, restartRequired: Object.keys(applied).length > 0 })
    } catch (error) {
      sendJson(res, 400, { error: String(error?.message || error) })
    }
  })

  register(`${ROUTE_PREFIX}/test`, async (req, res) => {
    if (!isLoopback(req)) { sendJson(res, 403, { error: 'loopback only' }); return }
    if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return }
    try {
      const auth = await authStatus()
      const openId = auth?.identities?.user?.openId
      if (!openId) { sendJson(res, 409, { error: '飞书用户身份不可用，请先完成授权' }); return }
      const status = await buildStatus()
      const config = readJson(CONFIG_PATH, {})
      const interval = readByPath(config, 'card.intervalMs') ?? 350
      const sessionChats = config.sessionChats !== false
      const routes = sessionChats ? '每会话独立群' : (config.thread === true ? '话题模式' : '平铺消息')

      const tile = (label, value) => ({
        tag: 'column', width: 'weighted', weight: 1,
        elements: [{
          tag: 'markdown',
          content: `<font color='grey'>${label}</font>\n**${value}**`,
        }],
      })
      const card = {
        schema: '2.0',
        config: { update_multi: true, width_mode: 'default' },
        header: {
          title: { tag: 'plain_text', content: '飞书桥 · 连通测试' },
          subtitle: { tag: 'plain_text', content: `来自 DSH 设置 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` },
          template: 'blue',
        },
        body: {
          elements: [
            { tag: 'markdown', content: '**✅ 通道正常**\n机器人身份可用，这条卡片由控制面板直接发出，没有经过模型。' },
            { tag: 'hr' },
            {
              tag: 'column_set', flex_mode: 'none',
              columns: [tile('已映射会话', String(status.bindings.sessions)), tile('会话群', String(status.bindings.chats))],
            },
            {
              tag: 'column_set', flex_mode: 'none',
              columns: [tile('卡片回调', String(status.bindings.callbacks)), tile('刷新间隔', `${interval}ms`)],
            },
            {
              tag: 'column_set', flex_mode: 'none',
              columns: [tile('会话形态', routes), tile('App Secret', status.secretPresent ? '已配置' : '未配置')],
            },
            { tag: 'hr' },
            { tag: 'markdown', content: "<font color='grey'>在「设置 → 飞书」里可调整流式节奏、审批位置与展示内容；改完重启 DSH 生效。</font>" },
          ],
        },
      }

      const payload = join(tmpdir(), `dsh-feishu-test-${Date.now()}.json`)
      writeFileSync(payload, JSON.stringify(card), 'utf8')
      await larkJson([
        'im', '+messages-send', '--as', 'bot', '--user-id', openId,
        '--msg-type', 'interactive', '--content', `@${payload}`,
      ], 30_000)
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message || error).slice(0, 300) })
    }
  })

  ctx.effect(() => () => { for (const off of dispose) off() }, 'feishu-panel: routes')
}
