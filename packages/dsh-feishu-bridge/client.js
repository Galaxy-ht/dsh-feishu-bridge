/**
 * dsh-feishu-panel — Client half.
 *
 * Registers one page in Settings ("飞书") that renders the Host's declarative
 * schema and writes the same `feishu-card.json` the bridge reads. All values,
 * labels and status facts come from the Host; this module only lays them out,
 * so adding a setting never requires touching the Client.
 */
window.__ModuleLoader__.load({
  id: '@ethanhale_/dsh-feishu-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const h = react.createElement
    const NS = 'dsh-feishu-panel'

    const zh = {
      nav: '飞书',
      title: '飞书桥控制面板',
      subtitle: '配置会话映射、流式刷新、弹窗位置与展示内容；保存后重启 DSH 生效。',
      refresh: '重新读取',
      save: '保存',
      saved: '已保存，重启 DSH 后生效',
      test: '发送测试消息',
      testing: '发送中…',
      testOk: '测试消息已发送',
      restartHint: '这些值由飞书桥在启动时读取，保存后需要重启 DSH。',
      status: '运行状态',
      identity: '飞书身份',
      bot: '机器人',
      user: '用户',
      callbacks: '卡片回调次数',
      sessions: '已映射会话',
      chats: '会话群',
      secret: 'App Secret',
      present: '已配置',
      absent: '未配置',
      lastError: '最近错误',
      none: '无',
      loadFailed: '读取失败',
      saveFailed: '保存失败',
      saveNothing: '没有改动',
      configPath: '配置文件',
      loginHint: '机器人或用户身份异常时，在终端运行 lark-cli auth login --recommend 后重新读取。',
      login: '登录与凭据',
      loginDesc: '机器人凭据决定「以谁的身份发卡片」，用户身份决定「代表你操作飞书」。',
      appId: 'App ID',
      appIdHelp: '开放平台 → 凭证与基础信息，形如 cli_xxx。',
      appSecret: 'App Secret',
      saveCreds: '保存凭据',
      credsSaved: '凭据已保存，重启 DSH 后生效',
      userIdentity: '用户身份',
      loginHelp: '扫码或浏览器授权后，插件就能以你的身份读写云文档、日历、任务等。',
      startLogin: '扫码 / 浏览器授权',
      cancel: '取消',
      scanHint: '用飞书 App 扫这个码，手机上点「授权」即可。',
      openBrowser: '在浏览器打开',
      pendingHint: '等待手机上确认…（授权链接 10 分钟内有效）',
      loginOk: '授权完成，身份已刷新。',
      badgeReady: '就绪',
      badgeWarn: '待授权',
      bridgeState: '桥状态',
      stateOn: '已启用',
      stateOff: '已停用',
      scopeCheck: '授权检查',
      scopeCheckHelp: '检查用户 scope 与应用权限是否齐全，缺的可以一键补齐。',
      recheck: '重新检查',
      userScopes: '用户授权',
      grantedLabel: '已授权',
      missingLabel: '缺',
      allGood: '齐全',
      fixScopes: '一键补齐授权',
      tenantScopes: '应用权限',
      openConsole: '去开放平台申请',
    }
    const en = {
      nav: 'Feishu',
      title: 'Feishu bridge panel',
      subtitle: 'Session mapping, streaming, dialog placement and card content. Changes apply after a DSH restart.',
      refresh: 'Reload',
      save: 'Save',
      saved: 'Saved — restart DSH to apply',
      test: 'Send test message',
      testing: 'Sending…',
      testOk: 'Test message sent',
      restartHint: 'The bridge reads these values on startup, so a restart is required.',
      status: 'Status',
      identity: 'Feishu identity',
      bot: 'Bot',
      user: 'User',
      callbacks: 'Card callbacks',
      sessions: 'Mapped sessions',
      chats: 'Session chats',
      secret: 'App Secret',
      present: 'configured',
      absent: 'missing',
      lastError: 'Recent errors',
      none: 'none',
      loadFailed: 'Load failed',
      saveFailed: 'Save failed',
      saveNothing: 'Nothing changed',
      configPath: 'Config file',
      loginHint: 'If an identity is not ready, run `lark-cli auth login --recommend` in a terminal, then reload.',
      login: 'Sign-in and credentials',
      loginDesc: 'Bot credentials decide who sends the cards; the user identity lets DSH act as you.',
      appId: 'App ID',
      appIdHelp: 'Open Platform → Credentials, of the form cli_xxx.',
      appSecret: 'App Secret',
      saveCreds: 'Save credentials',
      credsSaved: 'Credentials saved — restart DSH to apply',
      userIdentity: 'User identity',
      loginHelp: 'After signing in, the bridge can read and write docs, calendar and tasks as you.',
      startLogin: 'Scan QR / authorize',
      cancel: 'Cancel',
      scanHint: 'Scan this code with the Feishu app and approve on your phone.',
      openBrowser: 'Open in browser',
      pendingHint: 'Waiting for approval on the phone… (link valid for 10 minutes)',
      loginOk: 'Signed in; identity refreshed.',
      badgeReady: 'ready',
      badgeWarn: 'pending',
      bridgeState: 'Bridge',
      stateOn: 'enabled',
      stateOff: 'disabled',
      scopeCheck: 'Authorization check',
      scopeCheckHelp: 'Checks user scopes and app permissions; anything missing can be repaired in one click.',
      recheck: 'Re-check',
      userScopes: 'User scopes',
      grantedLabel: 'granted',
      missingLabel: 'missing',
      allGood: 'all granted',
      fixScopes: 'Fix in one click',
      tenantScopes: 'App permissions',
      openConsole: 'Open approval page',
    }

    const style = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 2px 24px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
      h1: { margin: 0, fontSize: '16px', fontWeight: 600 },
      sub: { margin: '4px 0 0', fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      actions: { display: 'flex', gap: '8px', flexShrink: 0 },
      button: {
        font: 'inherit', fontSize: '13px', padding: '6px 12px', borderRadius: '8px',
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      primary: { borderColor: 'transparent', background: '#3370ff', color: '#fff' },
      group: { border: '1px solid rgba(128,128,128,.22)', borderRadius: '10px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' },
      groupTitle: { margin: 0, fontSize: '14px', fontWeight: 600 },
      groupDesc: { margin: 0, fontSize: '12px', opacity: 0.6 },
      row: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      labelBlock: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 },
      label: { fontSize: '13px' },
      help: { fontSize: '11px', opacity: 0.55, lineHeight: 1.45 },
      control: { flexShrink: 0, minWidth: '120px', display: 'flex', justifyContent: 'flex-end' },
      input: {
        font: 'inherit', fontSize: '13px', padding: '4px 8px', width: '96px', borderRadius: '6px',
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
      },
      select: {
        font: 'inherit', fontSize: '13px', padding: '4px 8px', borderRadius: '6px',
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
      },
      toggle: { width: '18px', height: '18px', accentColor: '#3370ff', cursor: 'pointer' },
      notice: { fontSize: '12px', padding: '8px 12px', borderRadius: '8px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' },
      stat: { border: '1px solid rgba(128,128,128,.18)', borderRadius: '8px', padding: '8px 10px' },
      statKey: { fontSize: '11px', opacity: 0.55 },
      statValue: { fontSize: '13px', marginTop: '2px', wordBreak: 'break-all' },
      hint: { fontSize: '12px', opacity: 0.6, lineHeight: 1.5 },
      error: { fontSize: '12px', color: '#d14343', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      badge: { padding: '1px 6px', borderRadius: '6px', fontSize: '11px', marginRight: '8px' },
      badgeOk: { background: 'rgba(82,196,26,.16)', color: '#3f8f1f' },
      badgeWarn: { background: 'rgba(250,173,20,.18)', color: '#a06400' },
      qr: { width: '168px', height: '168px', background: '#fff', padding: '8px', borderRadius: '8px', flexShrink: 0 },
      loginRow: { display: 'flex', gap: '16px', alignItems: 'flex-start' },
      link: { fontSize: '11px', opacity: 0.6, wordBreak: 'break-all', userSelect: 'all', lineHeight: 1.4 },
    }

    /** Read the active language from the locale service's dictionary choice. */
    function pick(value, lang) {
      if (!value) return ''
      return typeof value === 'string' ? value : (value[lang] || value.en || value.zh || '')
    }

    function readByPath(object, key) {
      return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), object)
    }

    function formatTime(value, lang) {
      if (!value) return ''
      try { return new Date(value).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') } catch { return '' }
    }

    function Panel(props) {
      const t = props.t
      const lang = t('nav') === zh.nav ? 'zh' : 'en'
      const [state, setState] = react.useState(null)
      const [draft, setDraft] = react.useState({})
      const [busy, setBusy] = react.useState('')
      const [notice, setNotice] = react.useState(null)
      const [auth, setAuth] = react.useState(null)
      const [cred, setCred] = react.useState({ appId: '', appSecret: '' })
      const [checks, setChecks] = react.useState(null)

      const load = react.useCallback(async () => {
        setBusy('load'); setNotice(null)
        try {
          const response = await fetch('/feishu-panel/state', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setState(data); setDraft({})
          setAuth(data.login && data.login.status !== 'idle' ? data.login : null)
          setCred(previous => ({ appId: data.credentials?.appId || previous.appId, appSecret: '' }))
          void loadChecks(false)
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('loadFailed')}: ${String(error && error.message || error)}` })
        } finally { setBusy('') }
      }, [t])

      react.useEffect(() => { void load() }, [load])

      // A key absent from the file is not "off": the bridge falls back to the
      // schema default, so the panel must show that same effective value.
      const valueOf = field => {
        if (Object.hasOwn(draft, field.key)) return draft[field.key]
        const stored = readByPath(state && state.config, field.key)
        return stored === undefined ? field.default : stored
      }
      const assign = (field, value) => setDraft(previous => ({ ...previous, [field.key]: value }))

      const save = async () => {
        if (Object.keys(draft).length === 0) { setNotice({ kind: 'info', text: t('saveNothing') }); return }
        setBusy('save'); setNotice(null)
        try {
          const response = await fetch('/feishu-panel/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: draft }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data && data.error || `HTTP ${response.status}`)
          setNotice({ kind: 'ok', text: t('saved') })
          await load()
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('saveFailed')}: ${String(error && error.message || error)}` })
        } finally { setBusy('') }
      }

      const sendTest = async () => {
        setBusy('test'); setNotice(null)
        try {
          const response = await fetch('/feishu-panel/test', { method: 'POST' })
          const data = await response.json()
          if (!response.ok) throw new Error(data && data.error || `HTTP ${response.status}`)
          setNotice({ kind: 'ok', text: t('testOk') })
        } catch (error) {
          setNotice({ kind: 'error', text: String(error && error.message || error) })
        } finally { setBusy('') }
      }

      // Device flow: the Host owns the polling process, this page only asks.
      const pending = Boolean(auth && auth.status === 'pending')
      react.useEffect(() => {
        if (!pending) return undefined
        const timer = setInterval(async () => {
          try {
            const response = await fetch('/feishu-panel/login/poll')
            const data = await response.json()
            setAuth(previous => ({ ...(previous || {}), ...data }))
            if (data.status === 'ok') { setNotice({ kind: 'ok', text: t('loginOk') }); void load() }
            if (data.status === 'error') setNotice({ kind: 'error', text: data.message || '授权失败' })
          } catch { /* keep polling */ }
        }, 2000)
        return () => clearInterval(timer)
      }, [pending, load, t])

      const startLogin = async (scopes) => {
        setBusy('login'); setNotice(null)
        try {
          const response = await fetch('/feishu-panel/login/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scopes: Array.isArray(scopes) ? scopes : [] }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data && data.error || `HTTP ${response.status}`)
          setAuth({ status: 'pending', url: data.url, expiresAt: data.expiresAt })
        } catch (error) {
          setNotice({ kind: 'error', text: String(error && error.message || error) })
        } finally { setBusy('') }
      }

      const loadChecks = async (force) => {
        setBusy('checks'); setNotice(null)
        try {
          const response = await fetch(`/feishu-panel/checks${force ? '?force=1' : ''}`)
          const data = await response.json()
          if (!response.ok) throw new Error(data && data.error || `HTTP ${response.status}`)
          setChecks(data)
        } catch (error) {
          setNotice({ kind: 'error', text: String(error && error.message || error) })
        } finally { setBusy('') }
      }

      const openConsole = async () => {
        if (!checks || !checks.consoleUrl) return
        const response = await fetch('/feishu-panel/console/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: checks.consoleUrl }),
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          setNotice({ kind: 'error', text: data.error || '打开浏览器失败' })
        }
      }

      const cancelLogin = async () => {
        await fetch('/feishu-panel/login/cancel', { method: 'POST' }).catch(() => {})
        setAuth(null); setNotice(null)
      }

      const openBrowser = async () => {
        const response = await fetch('/feishu-panel/login/open', { method: 'POST' })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          setNotice({ kind: 'error', text: data.error || '打开浏览器失败' })
        }
      }

      const saveCreds = async () => {
        setBusy('creds'); setNotice(null)
        try {
          const response = await fetch('/feishu-panel/credentials', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ appId: cred.appId, appSecret: cred.appSecret }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data && data.error || `HTTP ${response.status}`)
          setNotice({ kind: 'ok', text: t('credsSaved') })
          await load()
        } catch (error) {
          setNotice({ kind: 'error', text: String(error && error.message || error) })
        } finally { setBusy('') }
      }

      const renderField = (field) => {
        const value = valueOf(field)
        const label = pick(field.label, lang)
        const help = field.help ? pick(field.help, lang) : ''
        let control
        if (field.type === 'boolean') {
          control = h('input', {
            type: 'checkbox', style: style.toggle, checked: value === true,
            onChange: event => assign(field, event.target.checked),
          })
        } else if (field.type === 'number') {
          control = h('input', {
            type: 'number', style: style.input, value: value === undefined ? '' : value,
            min: field.min, max: field.max, step: field.step || 1,
            onChange: event => assign(field, event.target.value === '' ? '' : Number(event.target.value)),
          })
        } else {
          control = h('select', {
            style: style.select, value: value === undefined ? '' : value,
            onChange: event => assign(field, event.target.value),
          }, (field.options || []).map(option => h('option', { key: option.value, value: option.value }, pick(option.label, lang))))
        }
        return h('div', { key: field.key, style: style.row },
          h('div', { style: style.labelBlock },
            h('span', { style: style.label }, label),
            help ? h('span', { style: style.help }, help) : null),
          h('div', { style: style.control }, control))
      }

      const status = state && state.status

      const identityBadge = value => h('span', {
        style: { ...style.badge, ...(value === 'ready' ? style.badgeOk : style.badgeWarn) },
      }, value === 'ready' ? t('badgeReady') : t('badgeWarn'))

      const loginCard = h('section', { style: style.group },
        h('h2', { style: style.groupTitle }, t('login')),
        h('p', { style: style.groupDesc }, t('loginDesc')),

        h('div', { style: style.row },
          h('div', { style: style.labelBlock },
            h('span', { style: style.label }, t('appId')),
            h('span', { style: style.help }, t('appIdHelp'))),
          h('div', { style: style.control },
            h('input', {
              style: style.input, value: cred.appId, placeholder: 'cli_xxx', spellCheck: false,
              onChange: event => setCred(previous => ({ ...previous, appId: event.target.value })),
            }))),

        h('div', { style: style.row },
          h('div', { style: style.labelBlock },
            h('span', { style: style.label }, t('appSecret')),
            h('span', { style: style.help }, status && status.secretPresent ? t('present') : t('absent'))),
          h('div', { style: { ...style.control, gap: '8px' } },
            h('input', {
              style: style.input, type: 'password', value: cred.appSecret, placeholder: '••••••••',
              autoComplete: 'off',
              onChange: event => setCred(previous => ({ ...previous, appSecret: event.target.value })),
            }),
            h('button', {
              style: style.button, disabled: busy !== '', onClick: () => { void saveCreds() },
            }, t('saveCreds')))),

        h('div', { style: style.row },
          h('div', { style: style.labelBlock },
            h('span', { style: style.label }, t('userIdentity')),
            h('span', { style: style.help }, t('loginHelp'))),
          h('div', { style: { ...style.control, gap: '8px' } },
            status ? identityBadge(status.identity.user) : null,
            pending
              ? h('button', { style: style.button, onClick: () => { void cancelLogin() } }, t('cancel'))
              : h('button', {
                style: { ...style.button, ...style.primary }, disabled: busy !== '', onClick: () => { void startLogin() },
              }, t('startLogin')))),

        h('div', { style: style.row },
          h('div', { style: style.labelBlock },
            h('span', { style: style.label }, t('scopeCheck')),
            h('span', { style: style.help }, t('scopeCheckHelp'))),
          h('div', { style: style.control },
            h('button', {
              style: style.button, disabled: busy !== '', onClick: () => { void loadChecks(true) },
            }, t('recheck')))),

        checks
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: style.hint },
              `${t('userScopes')}: ${t('grantedLabel')} ${checks.user.granted} · ` +
              (checks.user.missing.length > 0 ? `${t('missingLabel')} ${checks.user.missing.join(', ')}` : t('allGood'))),
            checks.user.missing.length > 0
              ? h('div', null, h('button', {
                style: { ...style.button, ...style.primary }, disabled: busy !== '',
                onClick: () => { void startLogin(checks.user.missing) },
              }, t('fixScopes')))
              : null,
            h('div', { style: style.hint },
              `${t('tenantScopes')}: ` + (checks.tenant.missing.length > 0
                ? checks.tenant.missing.map(item => item.capability).join('、')
                : t('allGood'))),
            checks.tenant.missing.length > 0
              ? h('div', null, h('button', {
                style: style.button, disabled: busy !== '', onClick: () => { void openConsole() },
              }, t('openConsole')))
              : null)
          : null,

        pending
          ? h('div', { style: style.loginRow },
            h('img', { style: style.qr, src: `/feishu-panel/login/qr?t=${auth.expiresAt || 0}`, alt: 'QR' }),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } },
              h('div', { style: style.hint }, t('scanHint')),
              h('div', { style: style.link }, auth.url || ''),
              h('div', { style: style.hint }, t('pendingHint')),
              h('div', { style: { display: 'flex', gap: '8px' } },
                h('button', { style: style.button, onClick: () => { void openBrowser() } }, t('openBrowser')))))
          : null,

        auth && auth.status === 'error' ? h('div', { style: style.error }, String(auth.message || '')) : null)

      const header = h('div', { style: style.header },
        h('div', null,
          h('h1', { style: style.h1 }, t('title')),
          h('p', { style: style.sub }, t('subtitle'))),
        h('div', { style: style.actions },
          h('button', { style: style.button, disabled: busy !== '', onClick: () => { void load() } }, t('refresh')),
          h('button', { style: style.button, disabled: busy !== '', onClick: () => { void sendTest() } }, busy === 'test' ? t('testing') : t('test')),
          h('button', { style: { ...style.button, ...style.primary }, disabled: busy !== '', onClick: () => { void save() } }, t('save'))))

      const noticeLine = notice
        ? h('div', {
          style: { ...style.notice, ...(notice.kind === 'error' ? { color: '#d14343', background: 'rgba(209,67,67,.08)' } : { background: 'rgba(51,112,255,.08)' }) },
        }, notice.text)
        : null

      const statusBlock = status
        ? h('section', { style: style.group },
          h('h2', { style: style.groupTitle }, t('status')),
          h('div', { style: style.grid },
            h('div', { style: style.stat },
              h('div', { style: style.statKey }, t('bridgeState')),
              h('div', { style: { ...style.statValue, color: status.enabled ? '#3f8f1f' : '#d14343' } },
                status.enabled ? t('stateOn') : t('stateOff'))),
            h('div', { style: style.stat }, h('div', { style: style.statKey }, t('identity')),
              h('div', { style: style.statValue }, `${t('bot')}: ${status.identity.bot} · ${t('user')}: ${status.identity.user}`)),
            h('div', { style: style.stat }, h('div', { style: style.statKey }, t('callbacks')),
              h('div', { style: style.statValue }, String(status.bindings.callbacks))),
            h('div', { style: style.stat }, h('div', { style: style.statKey }, t('sessions')),
              h('div', { style: style.statValue }, String(status.bindings.sessions))),
            h('div', { style: style.stat }, h('div', { style: style.statKey }, t('chats')),
              h('div', { style: style.statValue }, String(status.bindings.chats))),
            h('div', { style: style.stat }, h('div', { style: style.statKey }, t('secret')),
              h('div', { style: style.statValue }, status.secretPresent ? t('present') : t('absent'))),
            h('div', { style: style.stat }, h('div', { style: style.statKey }, t('configPath')),
              h('div', { style: style.statValue }, status.configPath))),
          status.errors && status.errors.length > 0
            ? h('div', { style: style.error }, `${t('lastError')}:\n${status.errors.join('\n')}`)
            : h('div', { style: style.hint }, `${t('lastError')}: ${t('none')}`),
          (status.identity.bot !== 'ready' || status.identity.user !== 'ready')
            ? h('div', { style: style.hint }, t('loginHint'))
            : null)
        : null

      const groups = (state && state.schema || []).map(group => h('section', { key: group.id, style: style.group },
        h('h2', { style: style.groupTitle }, pick(group.title, lang)),
        group.description ? h('p', { style: style.groupDesc }, pick(group.description, lang)) : null,
        ...(group.fields || []).map(renderField)))

      return h('div', { style: style.root }, header, noticeLine, loginCard, statusBlock, ...groups,
        h('p', { style: style.hint }, t('restartHint')))
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-feishu-panel: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'feishu',
        order: 45,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, Panel)), 'dsh-feishu-panel: settings section')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
