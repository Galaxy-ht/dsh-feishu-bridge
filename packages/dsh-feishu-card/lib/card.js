/**
 * Feishu Card 2.0 builders for the DSH bridge.
 *
 * Everything here is pure: no I/O, no host services, no timers. The whole
 * point is that a card is a deterministic function of the turn state, so a
 * live stream update and the final render go through exactly the same code.
 */

/** Visual language per turn state: header colour, status tag, icon. */
export const STATUS_STYLE = {
  running: { template: 'blue', tag: '运行中', tagColor: 'blue', icon: 'ai-common_colorful', word: '执行中' },
  waiting: { template: 'orange', tag: '待确认', tagColor: 'orange', icon: 'approval_colorful', word: '等待确认' },
  done: { template: 'green', tag: '已完成', tagColor: 'green', icon: 'ai-common_colorful', word: '已完成' },
  error: { template: 'red', tag: '失败', tagColor: 'red', icon: 'ai-common_colorful', word: '运行失败' },
  'max-tokens': { template: 'orange', tag: '已达上限', tagColor: 'orange', icon: 'ai-common_colorful', word: '达到 Token 上限' },
  aborted: { template: 'grey', tag: '已中断', tagColor: 'neutral', icon: 'ai-common_colorful', word: '已中断' },
  blocked: { template: 'grey', tag: '未执行', tagColor: 'neutral', icon: 'ai-common_colorful', word: '未执行' },
}

const DONE_MARK = "<font color='green'>✔</font>"
const FAIL_MARK = "<font color='red'>✖</font>"
const RUN_MARK = "<font color='blue'>●</font>"
const IDLE_MARK = "<font color='grey'>○</font>"

/** Round a duration for humans: `820ms`, `7.4s`, `1m02s`. */
export function formatDuration(milliseconds) {
  const ms = Number(milliseconds)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes}m${String(rest).padStart(2, '0')}s`
}

/** Compact token counts: `856`, `1.2k`, `18k`. */
export function formatCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  if (number < 1000) return String(Math.round(number))
  if (number < 10000) return `${(number / 1000).toFixed(1)}k`
  return `${Math.round(number / 1000)}k`
}

/**
 * Escape the characters Card markdown would read as markup, but leave fenced
 * code blocks byte-identical: inside a fence the client renders text literally
 * and an escaped `&lt;` would show up as the entity itself.
 */
export function sanitizeMarkdown(text) {
  const source = String(text ?? '')
    // A fence glued to the end of a sentence does not open a code block in the
    // card renderer; give it the line break it needs.
    .replace(/([^\n`])```/g, '$1\n\n```')
  const parts = source.split(/(```[\s\S]*?(?:```|$))/)
  return parts
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/</g, '&#60;')))
    .join('')
}

/** A single markdown element. */
function markdown(content, extra = {}) {
  return { tag: 'markdown', content, ...extra }
}

/** Shorten a one-line string without cutting a surrogate pair. */
export function clip(text, limit) {
  const chars = Array.from(String(text ?? ''))
  if (chars.length <= limit) return chars.join('')
  return `${chars.slice(0, Math.max(0, limit - 1)).join('')}…`
}

/** Collapse a tool argument blob to one readable line. */
export function summarizeToolArguments(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw) } catch { return clip(String(raw).replace(/\s+/g, ' '), 90) }
  }
  if (!value || typeof value !== 'object') return clip(String(value ?? '').replace(/\s+/g, ' '), 90)
  const preferred = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'task', 'name']
  for (const key of preferred) {
    const item = value[key]
    if (typeof item === 'string' && item.trim()) return clip(item.replace(/\s+/g, ' '), 90)
  }
  for (const item of Object.values(value)) {
    if (typeof item === 'string' && item.trim()) return clip(item.replace(/\s+/g, ' '), 90)
  }
  return ''
}

/** One timeline row: mark + bold tool name + dim summary + dim duration. */
function timelineLine(item) {
  const mark = item.state === 'error' ? FAIL_MARK : item.state === 'running' ? RUN_MARK : item.state === 'idle' ? IDLE_MARK : DONE_MARK
  const name = `**${clip(item.name || 'tool', 24).replace(/</g, '&#60;')}**`
  const summary = item.summary ? ` \`${String(item.summary).replace(/[`<]/g, character => (character === '<' ? '&#60;' : "'"))}\`` : ''
  const duration = item.durationMs ? ` <font color='grey'>${formatDuration(item.durationMs)}</font>` : ''
  const detail = item.error ? `\n<font color='red'>${clip(item.error, 160).replace(/</g, '&#60;')}</font>` : ''
  return `${mark} ${name}${summary}${duration}${detail}`
}

function activityElement(view) {
  const style = STATUS_STYLE[view.status] ?? STATUS_STYLE.running
  const elapsed = view.elapsedMs ? ` <font color='grey'>· ${formatDuration(view.elapsedMs)}</font>` : ''
  const lines = [`${RUN_MARK} **${style.word}**${elapsed}`]
  if (view.activity) lines.push(`<font color='grey'>${clip(view.activity, 160)}</font>`)
  return markdown(lines.join('\n'))
}

function fieldsElement(fields) {
  const items = fields
    .filter(field => field && field.value !== undefined && field.value !== '')
    .map(field => ({
      is_short: field.wide !== true,
      text: { tag: 'lark_md', content: `**${field.label}**\n${field.value}` },
    }))
  if (items.length === 0) return undefined
  return { tag: 'div', fields: items }
}

function processPanel(view) {
  const items = Array.isArray(view.timeline) ? view.timeline : []
  if (items.length === 0) return undefined
  const body = []
  if (view.reasoning) {
    body.push(markdown(`<font color='grey'>思考过程</font>\n${sanitizeMarkdown(view.reasoning)}`))
  }
  body.push(markdown(items.map(timelineLine).join('\n')))
  const steps = `${items.length} 步`
  const spent = view.toolDurationMs ? ` · ${formatDuration(view.toolDurationMs)}` : ''
  return {
    tag: 'collapsible_panel',
    expanded: view.status === 'running' || view.status === 'waiting',
    header: {
      title: { tag: 'markdown', content: `**执行过程** <font color='grey'>· ${steps}${spent}</font>` },
      width: 'fill',
      vertical_align: 'center',
    },
    border: { color: 'grey-200', corner_radius: '8px' },
    vertical_spacing: '4px',
    padding: '8px 12px 8px 12px',
    elements: body,
  }
}

function metaLine(view) {
  const meta = view.meta || {}
  const parts = []
  if (meta.model) parts.push(`\`${clip(meta.model, 32)}\``)
  if (meta.durationMs) parts.push(formatDuration(meta.durationMs))
  if (meta.inputTokens) parts.push(`↑ ${formatCount(meta.inputTokens)}`)
  if (meta.outputTokens) parts.push(`↓ ${formatCount(meta.outputTokens)}`)
  if (meta.contextPercent) parts.push(`上下文 ${meta.contextPercent}%`)
  if (parts.length === 0) return undefined
  return markdown(`<font color='grey'>${parts.join(' · ')}</font>`, { text_size: 'notation' })
}

function actionsElement(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return undefined
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: actions.map(action => ({
      tag: 'column',
      width: 'auto',
      elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: clip(action.label, 40) },
        type: action.type || 'default',
        size: 'medium',
        ...(action.disabled ? { disabled: true } : {}),
        behaviors: [{ type: 'callback', value: action.value ?? {} }],
      }],
    })),
  }
}

/**
 * A form for answering: an optional dropdown (single or multi select) plus a
 * free-text input, submitted together.
 *
 * Feishu only reports form contents on submit (`form_value`), and the button
 * inside a form uses `form_action_type` instead of `behaviors`.
 */
function formElement(form) {
  const elements = []
  if (Array.isArray(form.fields)) {
    // Multi-question form: label, optional dropdown, optional free text, then
    // one submit for the whole batch.
    for (const field of form.fields) {
      if (!field) continue
      if (field.kind === 'label') {
        elements.push({ tag: 'markdown', content: field.markdown || '' })
        continue
      }
      if (field.kind === 'checkers') {
        // A multi-select rendered as explicit checkboxes: the dropdown variant
        // is easy to mistake for single-select, checkboxes are not.
        for (const [index, label] of (field.options || []).entries()) {
          elements.push({
            tag: 'checker',
            name: `${field.name}_${index}`,
            checked: false,
            text: { tag: 'plain_text', content: clip(label, 60) },
          })
        }
        continue
      }
      if (field.kind === 'select' || field.kind === 'multi') {
        const options = (field.options || []).map(label => ({
          text: { tag: 'plain_text', content: clip(label, 60) },
          value: clip(label, 60),
        }))
        elements.push(field.kind === 'multi'
          ? {
            tag: 'multi_select_static',
            name: field.name,
            placeholder: { tag: 'plain_text', content: clip(field.placeholder || '可多选', 40) },
            options,
            width: 'fill',
            // Inside a form Feishu only submits one value for a multi-select,
            // so every change also reports the complete set through a callback.
            ...(field.callback ? { behaviors: [{ type: 'callback', value: field.callback }] } : {}),
          }
          : { tag: 'select_static', name: field.name, placeholder: { tag: 'plain_text', content: clip(field.placeholder || '选择一项', 40) }, options, width: 'fill' })
        continue
      }
      elements.push({
        tag: 'input',
        name: field.name,
        placeholder: { tag: 'plain_text', content: clip(field.placeholder || '输入答案', 60) },
        input_type: field.multiline ? 'multiline_text' : 'text',
        max_length: 1000,
        width: 'fill',
      })
    }
    elements.push({
      tag: 'button',
      name: 'submit',
      text: { tag: 'plain_text', content: clip(form.submitLabel || '提交', 12) },
      type: 'primary_filled',
      form_action_type: 'submit',
    })
    return { tag: 'form', name: form.name || 'answer_form', elements }
  }

  if (Array.isArray(form.options) && form.options.length > 0) {
    const options = form.options.map(label => ({
      text: { tag: 'plain_text', content: clip(label, 60) },
      value: clip(label, 60),
    }))
    elements.push(form.multi
      ? {
        tag: 'multi_select_static',
        name: 'selection',
        placeholder: { tag: 'plain_text', content: '可多选，选完点提交' },
        options,
        width: 'fill',
      }
      : {
        tag: 'select_static',
        name: 'selection',
        placeholder: { tag: 'plain_text', content: '从列表中选择' },
        options,
        width: 'fill',
      })
  }
  elements.push({
    tag: 'input',
    name: 'custom',
    placeholder: { tag: 'plain_text', content: clip(form.placeholder || '或者在这里输入你的答案…', 60) },
    input_type: form.multiline ? 'multiline_text' : 'text',
    rows: form.multiline ? 3 : undefined,
    max_length: 1000,
    width: 'fill',
  })
  elements.push({
    tag: 'button',
    name: 'submit',
    text: { tag: 'plain_text', content: clip(form.submitLabel || '提交', 12) },
    type: 'primary_filled',
    form_action_type: 'submit',
  })
  return { tag: 'form', name: form.name || 'answer_form', elements }
}

/**
 * Build one Card 2.0 payload from a view.
 *
 * The body reads top-down as: live status (while running) → what was asked
 * (prompt cards) → the answer → the work that produced it → accounting →
 * actions. Every section is optional, so a turn with no tools and no footer
 * still renders as a clean title + answer card.
 */
export function buildCard(view) {
  const style = STATUS_STYLE[view.status] ?? STATUS_STYLE.running
  const elements = []

  if (view.status === 'running' || view.status === 'waiting') {
    elements.push(activityElement(view))
  }
  const fields = view.fields ? fieldsElement(view.fields) : undefined
  if (fields) elements.push(fields)
  if (view.answer) elements.push(markdown(view.answer))
  if (view.code) {
    elements.push(markdown(`\`\`\`\n${String(view.code).replace(/```/g, 'ˋˋˋ')}\n\`\`\``))
  }
  const panel = processPanel(view)
  if (panel) elements.push(panel)
  const meta = metaLine(view)
  if (meta) elements.push(meta)
  const actions = actionsElement(view.actions)
  if (actions) elements.push(actions)
  if (view.form) elements.push(formElement(view.form))
  if (view.hint) {
    elements.push(markdown(`<font color='grey'>${sanitizeMarkdown(view.hint)}</font>`, { text_size: 'notation' }))
  }
  if (view.status !== 'running' && view.status !== 'waiting' && elements.length === 0) {
    elements.push(markdown("<font color='grey'>本轮没有输出。</font>"))
  }

  const summary = view.summary || view.answer || view.hint || style.word
  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: view.widthMode || 'default',
      summary: { content: clip(String(summary).replace(/\s+/g, ' '), 80) },
    },
    header: {
      title: { tag: 'plain_text', content: clip(view.title || 'DeepSeek Harness', 60) },
      ...(view.subtitle ? { subtitle: { tag: 'plain_text', content: clip(view.subtitle, 80) } } : {}),
      template: style.template,
      icon: { tag: 'standard_icon', token: view.icon || style.icon },
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: style.tag }, color: style.tagColor },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements,
    },
  }
  return card
}

/** Serialized byte size of a card, which is what the 30 KB API limit measures. */
export function cardBytes(card) {
  return Buffer.byteLength(JSON.stringify(card), 'utf8')
}

/**
 * The three streamed text parts of a live card.
 *
 * They are computed once per tick so the streaming card and the per-element
 * updates can never disagree about what the card currently says.
 */
export function streamingParts(view) {
  const style = STATUS_STYLE[view.status] ?? STATUS_STYLE.running
  const elapsed = view.elapsedMs ? ` <font color='grey'>· ${formatDuration(view.elapsedMs)}</font>` : ''
  const statusLines = [`${RUN_MARK} **${style.word}**${elapsed}`]
  if (view.activity) statusLines.push(`<font color='grey'>${clip(view.activity, 160)}</font>`)

  const meta = view.meta || {}
  const metaParts = []
  if (meta.model) metaParts.push(`\`${clip(meta.model, 32)}\``)
  if (meta.durationMs) metaParts.push(formatDuration(meta.durationMs))
  if (meta.inputTokens) metaParts.push(`↑ ${formatCount(meta.inputTokens)}`)
  if (meta.outputTokens) metaParts.push(`↓ ${formatCount(meta.outputTokens)}`)
  if (meta.contextPercent) metaParts.push(`上下文 ${meta.contextPercent}%`)

  return {
    status: statusLines.join('\n'),
    answer: view.answer || '',
    meta: `<font color='grey'>${metaParts.join(' · ') || '·'}</font>`,
  }
}

/**
 * Build the live card used while a turn is running.
 *
 * This is the CardKit variant: a fixed set of elements (`status`, `answer`,
 * `meta`) that get streamed independently, with `streaming_mode` on so the
 * client renders arriving text with its own typewriter rhythm. The process
 * panel is deliberately absent here — it is part of the final layout, which
 * replaces this card in one full update when the turn ends.
 */
export function buildStreamingCard(view) {
  const style = STATUS_STYLE[view.status] ?? STATUS_STYLE.running
  const parts = streamingParts(view)
  const elements = [
    { tag: 'markdown', element_id: 'status', content: parts.status },
    { tag: 'markdown', element_id: 'answer', content: parts.answer },
    { tag: 'markdown', element_id: 'meta', content: parts.meta },
  ]
  const actions = actionsElement(view.actions)
  if (actions) elements.push({ ...actions, element_id: 'actions' })

  const summary = view.summary || view.answer || style.word
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: view.widthMode || 'default',
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 35 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
      summary: { content: clip(String(summary).replace(/\s+/g, ' '), 80) },
    },
    header: {
      title: { tag: 'plain_text', content: clip(view.title || 'DeepSeek Harness', 60) },
      ...(view.subtitle ? { subtitle: { tag: 'plain_text', content: clip(view.subtitle, 80) } } : {}),
      template: style.template,
      icon: { tag: 'standard_icon', token: view.icon || style.icon },
      text_tag_list: [
        { tag: 'text_tag', text: { tag: 'plain_text', content: style.tag }, color: style.tagColor },
      ],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      elements,
    },
  }
}

/**
 * Fit a view into the API's card budget by shortening only the answer body.
 *
 * Returns the largest prefix of `view.answer` that fits plus the dropped
 * remainder, so a caller can deliver the rest as a follow-up message instead
 * of silently losing it. Everything except the answer is treated as fixed
 * cost; if even an empty answer cannot fit, the card is returned as built.
 */
export function fitCard(view, maxBytes = 27000) {
  const card = buildCard(view)
  if (cardBytes(card) <= maxBytes) return { card, dropped: '' }
  const answer = String(view.answer ?? '')
  if (!answer) return { card, dropped: '' }

  let low = 0
  let high = answer.length
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = buildCard({ ...view, answer: `${answer.slice(0, middle)}\n\n…（内容较长，剩余部分随后单独发送）` })
    if (cardBytes(candidate) <= maxBytes) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const kept = answer.slice(0, best)
  const dropped = answer.slice(best)
  return {
    card: buildCard({ ...view, answer: `${kept}\n\n…（内容较长，剩余部分随后单独发送）` }),
    dropped,
  }
}
