/**
 * dsh-todolist — 独立待办看板（服务端）。
 *
 * 完全自建的待办系统，使用独立的本地存储：
 * - 存储：<dataDir>/todos.json（全部待办）
 * - API：/todolist/api/todo（list/add/done/update/remove）
 * - AI 工具：todolist（操作待办）
 * - 快照：注入使用说明 + 每轮收尾到期检查
 *
 * 条目字段：id / content / proj / who / start / due / repeat / on / quadrant /
 * status / createdAt / doneAt / last / calendarOrder（可选，月历/周视图共用）。状态：pending|doing|done|blocked|cancelled。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = '@hz-jasonlin/dsh-todolist'
export const inject = ['tools', 'systemPrompt', 'webServer']

const DEFAULTS = {
  dataDir: null,             // null → <dshHome>/todo-data
  toolName: 'todolist',
  snapshotOrder: 420,
  maxListView: 8,
}

const STATUSES = ['pending', 'doing', 'done', 'blocked', 'cancelled']
const REPEATS = ['daily', 'weekly', 'monthly']

/** 'YYYY-MM-DD'（本地时区）。 */
function todayStamp() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 'YYYY-MM-DD HH:MM'（本地时区）。 */
function nowStamp() {
  const d = new Date()
  return `${todayStamp()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 8-hex id。 */
function newId() {
  return randomBytes(4).toString('hex')
}

/** 周期标识 → 中文（含定点）。 */
function repeatLabel(repeat, on = null) {
  if (repeat === 'daily') return '每天'
  if (repeat === 'weekly') return on ? `每周${['一', '二', '三', '四', '五', '六', '日'][on - 1] ?? ''}` : '每周'
  if (repeat === 'monthly') return on ? `每月${on}号` : '每月'
  return repeat
}

/** 字段清洗：undefined/null/空串 → null，否则 trim 后的字符串。 */
function cleanField(v) {
  if (v === undefined || v === null) return null
  const s = String(v)
  return s.trim() === '' ? null : s.trim()
}

/** ISO 时间戳（毫秒精度，用于 updatedAt 变更检测）。 */
function nowIso() {
  return new Date().toISOString()
}

/** 'HH:MM'（24 小时制）。 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 标签清洗：去空、去重（大小写不敏感）、保留首次写法。 */
function cleanTags(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const value of raw) {
    const tag = String(value ?? '').trim()
    if (tag === '') continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** 按配置限制标签数量与长度（超长截断、超量丢弃）。 */
function applyTagLimits(tags, limits) {
  const maxPerTask = Number.isInteger(limits?.maxPerTask) ? limits.maxPerTask : 8
  const maxLength = Number.isInteger(limits?.maxLength) ? limits.maxLength : 20
  return tags
    .slice(0, maxPerTask)
    .map((tag) => (tag.length > maxLength ? tag.slice(0, maxLength) : tag))
}

/** 'YYYY-MM-DD' 是否为合法真实日期（含 2 月 30 日等非法日期拦截）。 */
function isValidDateKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

/**
 * 规范化周期定点 on（配合 repeat）：
 * - daily / 无 repeat → null；
 * - weekly：1-7（1=周一 … 7=周日），缺失 → 默认今天星期几；
 * - monthly：1-31，缺失 → 默认今天几号；
 * - 显式传了越界/非整数 → 抛错（拒绝写库）。
 */
function normalizeOn(repeat, on, now = new Date()) {
  if (repeat === 'daily' || repeat === null) return null
  if (repeat === 'weekly') {
    if (on === null || on === undefined || on === '') {
      const dow = now.getDay()
      return dow === 0 ? 7 : dow
    }
    const n = Number(on)
    if (!Number.isInteger(n) || n < 1 || n > 7) throw new Error(`weekly 的 on 应为 1-7（1=周一 … 7=周日），收到：${on}`)
    return n
  }
  if (repeat === 'monthly') {
    if (on === null || on === undefined || on === '') {
      return now.getDate()
    }
    const n = Number(on)
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error(`monthly 的 on 应为 1-31（几号），收到：${on}`)
    return n
  }
  return null
}

/** 周期任务在某日期是否匹配（与服务端 list 智能视图、前端日历共用口径）。 */
function repeatMatches(repeat, on, date) {
  if (repeat === 'daily') return true
  if (repeat === 'weekly') return on !== null && date.getDay() === (on % 7)
  if (repeat === 'monthly') return on !== null && date.getDate() === on
  return false
}

export function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('dsh-todolist: 配置必须是对象')
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error(`dsh-todolist: 未知配置项 "${key}"`)
    config[key] = value
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  config.dataDir = config.dataDir ?? join(home, 'todo-data')
  if (typeof config.toolName !== 'string' || !config.toolName) throw new Error('dsh-todolist: toolName 必须是非空字符串')
  return config
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

/** 原子写 JSON 文件。 */
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

class JsonStore {
  constructor(file, fallback) {
    this.file = file
    this.fallback = fallback
  }
  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed ?? this.fallback
    } catch {
      return this.fallback
    }
  }
  save(data) {
    writeJson(this.file, data)
  }
}

/** 月历/周视图共用排序值：旧数据缺失时退回原始存储顺序，保持兼容且稳定。 */
function calendarSortKey(item, storageIndex) {
  return typeof item.calendarOrder === 'number' && Number.isFinite(item.calendarOrder)
    ? item.calendarOrder
    : storageIndex
}

/** 按月历/周视图共用顺序排序；相同排序值继续使用存储顺序作为稳定 tie-breaker。 */
function sortCalendarItems(items) {
  return items
    .map((item, index) => ({ item, index, key: calendarSortKey(item, index) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map(({ item }) => item)
}

/** 待办存储。 */
export class TodoStore {
  constructor(file, maxListView = 8, configStore = null) {
    this.file = file
    this.maxListView = maxListView
    this.configStore = configStore
  }
  /** 当前标签限制（来自 config.json）。 */
  limits() {
    try {
      return this.configStore?.read()?.tags ?? { maxPerTask: 8, maxLength: 20 }
    } catch {
      return { maxPerTask: 8, maxLength: 20 }
    }
  }
  /** 子任务：父任务必须存在且本身是顶层任务。 */
  validateParent(parentId, selfId = null) {
    if (parentId === null || parentId === undefined) return null
    if (selfId !== null && parentId === selfId) return '父任务不能是任务自己'
    const parent = this.findById(parentId)
    if (!parent) return `没有找到父任务 "${parentId}"`
    if (parent.parentId) return '子任务不能再包含子任务（仅支持一层）'
    return null
  }
  /** 任务模型补全（v2 字段迁移），返回是否有改动。 */
  normalizeItem(item) {
    let changed = false
    const set = (key, value) => {
      if (item[key] !== value) {
        item[key] = value
        changed = true
      }
    }
    if (item.createdAt === undefined || item.createdAt === null) set('createdAt', nowStamp())
    if (item.updatedAt === undefined || item.updatedAt === null) set('updatedAt', item.createdAt)
    if (item.parentId === undefined) set('parentId', null)
    if (item.dueTime === undefined) set('dueTime', null)
    if (item.reminderSent === undefined) set('reminderSent', null)
    if (!Array.isArray(item.tags)) {
      set('tags', [])
    } else {
      const next = applyTagLimits(cleanTags(item.tags), this.limits())
      if (JSON.stringify(next) !== JSON.stringify(item.tags)) set('tags', next)
    }
    return changed
  }
  all() {
    return this.load().items
  }
  load() {
    const data = new JsonStore(this.file, { version: 1, items: [] }).load()
    const items = Array.isArray(data.items) ? data.items : []
    const ordered = sortCalendarItems(items)
    let changed = false
    ordered.forEach((item, index) => {
      if (this.normalizeItem(item)) changed = true
      if (item.calendarOrder !== index) {
        item.calendarOrder = index
        changed = true
      }
      // Older records could retain fixed dates after being converted to a
      // recurring task. Recurrences derive dates from repeat/on only.
      if (item.repeat !== null && (item.start !== null || item.due !== null)) {
        item.start = null
        item.due = null
        changed = true
      }
    })
    // 兼容迁移直接落盘，不调用 save()/load()，避免递归；底层数组物理顺序保持不变。
    if (changed) writeJson(this.file, { ...data, items })
    return { ...data, items }
  }
  save(items) {
    writeJson(this.file, { version: 1, items })
  }
  findById(id) {
    return this.all().find((it) => it.id === id) ?? null
  }
  add(fields) {
    const content = String(fields.content ?? '').trim()
    if (content === '') return { ok: false, message: '待办内容不能为空' }
    const repeat = cleanField(fields.repeat)
    if (repeat !== null && !REPEATS.includes(repeat)) return { ok: false, message: `repeat 必须是 daily/weekly/monthly，收到：${repeat}` }
    const start = cleanField(fields.start)
    if (start !== null && !isValidDateKey(start)) return { ok: false, message: `start 格式应为 YYYY-MM-DD：${start}` }
    const due = cleanField(fields.due)
    if (due !== null && !isValidDateKey(due)) return { ok: false, message: `due 格式应为 YYYY-MM-DD：${due}` }
    const quadrant = cleanField(fields.quadrant)
    if (quadrant !== null && !/^q[1-4]$/.test(quadrant)) return { ok: false, message: `quadrant 必须是 q1-q4，收到：${quadrant}` }
    const status = cleanField(fields.status) ?? 'pending'
    if (!STATUSES.includes(status)) return { ok: false, message: `status 必须是 ${STATUSES.join('/')}，收到：${status}` }
    let on = null
    try {
      on = normalizeOn(repeat, cleanField(fields.on))
    } catch (error) {
      return { ok: false, message: error.message }
    }
    const parentId = cleanField(fields.parentId)
    const parentError = this.validateParent(parentId)
    if (parentError) return { ok: false, message: parentError }
    const dueTime = cleanField(fields.dueTime)
    if (dueTime !== null && !TIME_RE.test(dueTime)) return { ok: false, message: `dueTime 格式应为 HH:MM：${dueTime}` }
    const tags = applyTagLimits(cleanTags(fields.tags), this.limits())
    const item = {
      id: newId(),
      content,
      proj: cleanField(fields.proj),
      who: cleanField(fields.who),
      start: repeat ? null : start,
      due: repeat ? null : due,
      dueTime: repeat ? null : dueTime,
      repeat,
      on,
      quadrant,
      status,
      parentId,
      tags,
      reminderSent: null,
      createdAt: nowStamp(),
      updatedAt: nowIso(),
      doneAt: null,
      last: null,
    }
    // 时间跨度填反自动交换（start > due → 视为用户填反）
    if (item.start && item.due && item.start > item.due) {
      const t = item.start
      item.start = item.due
      item.due = t
    }
    const items = this.all()
    const maxCalendarOrder = items.reduce((max, existing, index) => (
      Math.max(max, calendarSortKey(existing, index))
    ), -1)
    item.calendarOrder = maxCalendarOrder + 1
    items.push(item)
    this.save(items)
    return { ok: true, id: item.id, message: `已添加待办（${item.proj ?? '未归类'}）` }
  }
  update(id, patch) {
    const items = this.all()
    const index = items.findIndex((it) => it.id === id)
    if (index === -1) return { ok: false, message: `没有找到 id 为 "${id}" 的待办` }
    const prev = items[index]
    const item = { ...prev }

    if (patch.content !== undefined) {
      const c = String(patch.content ?? '').trim()
      if (c === '') return { ok: false, message: '待办内容不能为空' }
      item.content = c
    }
    if (patch.proj !== undefined) item.proj = cleanField(patch.proj)
    if (patch.who !== undefined) item.who = cleanField(patch.who)
    if (patch.last !== undefined) item.last = cleanField(patch.last)
    if (patch.parentId !== undefined) {
      const parentId = cleanField(patch.parentId)
      const parentError = this.validateParent(parentId, id)
      if (parentError) return { ok: false, message: parentError }
      if (parentId !== null && items.some((it) => it.parentId === id)) {
        return { ok: false, message: '该任务还有子任务，不能变成子任务' }
      }
      item.parentId = parentId
    }
    if (patch.tags !== undefined) {
      item.tags = applyTagLimits(cleanTags(patch.tags), this.limits())
    }
    if (patch.due !== undefined) item.reminderSent = null
    if (patch.dueTime !== undefined) {
      const dueTime = cleanField(patch.dueTime)
      if (dueTime !== null && !TIME_RE.test(dueTime)) return { ok: false, message: `dueTime 格式应为 HH:MM：${dueTime}` }
      item.dueTime = dueTime
      item.reminderSent = null
    }
    if (patch.repeat !== undefined) {
      const r = cleanField(patch.repeat)
      if (r !== null && !REPEATS.includes(r)) return { ok: false, message: `repeat 必须是 daily/weekly/monthly，收到：${r}` }
      item.repeat = r
    }
    if (patch.start !== undefined) {
      const s = cleanField(patch.start)
      if (s !== null && !isValidDateKey(s)) return { ok: false, message: `start 格式应为 YYYY-MM-DD：${s}` }
      item.start = s
    }
    if (patch.due !== undefined) {
      const d = cleanField(patch.due)
      if (d !== null && !isValidDateKey(d)) return { ok: false, message: `due 格式应为 YYYY-MM-DD：${d}` }
      item.due = d
    }
    if (patch.quadrant !== undefined) {
      const q = cleanField(patch.quadrant)
      if (q !== null && !/^q[1-4]$/.test(q)) return { ok: false, message: `quadrant 必须是 q1-q4，收到：${q}` }
      item.quadrant = q
    }
    if (patch.status !== undefined) {
      const st = cleanField(patch.status)
      if (st !== null && !STATUSES.includes(st)) return { ok: false, message: `status 必须是 ${STATUSES.join('/')}，收到：${st}` }
      if (st !== null) item.status = st
    }
    if (patch.on !== undefined) {
      const raw = patch.on
      if (raw === '' || raw === null) {
        item.on = null
      } else {
        const n = Number(raw)
        if (!Number.isInteger(n)) return { ok: false, message: `on 必须是整数，收到：${raw}` }
        item.on = n
      }
    }

    // 周期任务统一：不留固定日期；on 缺失 → 默认今天，越界 → 拒绝
    if (item.repeat !== null) {
      item.due = null
      item.start = null
      item.dueTime = null
      try {
        item.on = normalizeOn(item.repeat, item.on)
      } catch (error) {
        return { ok: false, message: error.message }
      }
    } else {
      item.on = null
      // 时间跨度填反自动交换（start > due → 视为用户填反）
      if (item.start && item.due && item.start > item.due) {
        const t = item.start
        item.start = item.due
        item.due = t
      }
    }
    if (item.status === 'done' && prev.status !== 'done') item.doneAt = item.doneAt ?? nowStamp()
    if (item.status !== 'done') item.doneAt = null
    item.updatedAt = nowIso()
    items[index] = item
    this.save(items)
    return { ok: true, message: '已更新待办' }
  }
  /** 持久化月历/周视图共用的跨天条顺序。position 只能是 before/after。 */
  reorder(id, targetId, position) {
    const sourceId = String(id ?? '').trim()
    const anchorId = String(targetId ?? '').trim()
    const relation = String(position ?? '').trim().toLowerCase()
    if (!sourceId) return { ok: false, message: 'reorder 的 id 不能为空' }
    if (!anchorId) return { ok: false, message: 'reorder 的 targetId 不能为空' }
    if (sourceId === anchorId) return { ok: false, message: 'reorder 的 id 与 targetId 不能相同' }
    if (relation !== 'before' && relation !== 'after') {
      return { ok: false, message: 'reorder 的 position 必须是 before 或 after' }
    }

    const items = this.all()
    const source = items.find((item) => item.id === sourceId)
    if (!source) return { ok: false, message: `没有找到 id 为 "${sourceId}" 的待办` }
    const target = items.find((item) => item.id === anchorId)
    if (!target) return { ok: false, message: `没有找到 targetId 为 "${anchorId}" 的待办` }

    const ordered = sortCalendarItems(items)
    const sourceIndex = ordered.findIndex((item) => item.id === sourceId)
    const targetIndex = ordered.findIndex((item) => item.id === anchorId)
    if (sourceIndex === -1 || targetIndex === -1) {
      return { ok: false, message: '无法确定日历排序位置' }
    }

    const [moved] = ordered.splice(sourceIndex, 1)
    let insertIndex = ordered.findIndex((item) => item.id === anchorId)
    if (insertIndex === -1) return { ok: false, message: '无法确定 targetId 的日历排序位置' }
    if (relation === 'after') insertIndex += 1
    ordered.splice(insertIndex, 0, moved)
    ordered.forEach((item, index) => { item.calendarOrder = index })
    // 保留底层数组的物理顺序，避免影响现有 list() 在相同排序键下的稳定顺序。
    this.save(items)
    return { ok: true, message: `已将待办移至${relation === 'before' ? '目标之前' : '目标之后'}`, order: ordered.map((item) => item.id) }
  }
  done(id) {
    const item = this.findById(id)
    if (!item) return { ok: false, message: `没有找到 id 为 "${id}" 的待办` }
    if (item.repeat) {
      // 周期任务：本轮完成，标记 last，状态保持 pending（按周期继续出现）
      const outcome = this.update(id, { status: 'pending', last: todayStamp() })
      if (outcome.ok) outcome.message = '已完成本轮，按周期继续'
      return outcome
    }
    return this.update(id, { status: 'done' })
  }
  remove(id, options = {}) {
    const cascade = options.cascade !== false
    const items = this.all()
    const target = items.find((it) => it.id === id)
    if (!target) return { ok: false, message: `没有找到 id 为 "${id}" 的待办` }
    const children = items.filter((it) => it.parentId === id)
    if (children.length > 0 && !cascade) {
      return { ok: false, message: `该任务有 ${children.length} 个子任务，需显式 cascade 才能删除` }
    }
    const removeIds = new Set([id, ...children.map((child) => child.id)])
    const next = items.filter((it) => !removeIds.has(it.id))
    this.save(next)
    return {
      ok: true,
      message: children.length > 0 ? `已删除待办（含 ${children.length} 个子任务）` : '已删除待办',
      removed: removeIds.size,
    }
  }
  /** 全局重命名标签（大小写不敏感匹配），返回受影响任务数。 */
  renameTag(from, to) {
    const source = String(from ?? '').trim()
    const target = String(to ?? '').trim()
    if (source === '') return { ok: false, message: '原标签不能为空' }
    if (target === '') return { ok: false, message: '新标签不能为空' }
    const limits = this.limits()
    if (target.length > limits.maxLength) return { ok: false, message: `标签长度上限为 ${limits.maxLength}` }
    const items = this.all()
    let affected = 0
    for (const item of items) {
      if (!Array.isArray(item.tags)) continue
      const next = cleanTags(item.tags.map((tag) => (tag.toLowerCase() === source.toLowerCase() ? target : tag)))
      if (JSON.stringify(next) !== JSON.stringify(item.tags)) {
        item.tags = applyTagLimits(next, limits)
        item.updatedAt = nowIso()
        affected++
      }
    }
    if (affected > 0) this.save(items)
    return { ok: true, affected, message: `已重命名 ${affected} 个任务上的标签` }
  }
  /** 全局删除标签，返回受影响任务数。 */
  removeTag(tag) {
    const target = String(tag ?? '').trim().toLowerCase()
    if (target === '') return { ok: false, message: '标签不能为空' }
    const items = this.all()
    let affected = 0
    for (const item of items) {
      if (!Array.isArray(item.tags)) continue
      const next = item.tags.filter((value) => value.toLowerCase() !== target)
      if (next.length !== item.tags.length) {
        item.tags = next
        item.updatedAt = nowIso()
        affected++
      }
    }
    if (affected > 0) this.save(items)
    return { ok: true, affected, message: `已从 ${affected} 个任务移除标签` }
  }
  list(options = {}) {
    const today = todayStamp()
    const todayDate = new Date()
    const done = (it) => it.status === 'done' || it.status === 'cancelled'
    const isOverdue = (it) => it.due !== null && it.due < today && !done(it)
    const isToday = (it) => it.due === today && !done(it)
    const isRepeatToday = (it) => it.repeat !== null && !done(it) && repeatMatches(it.repeat, it.on, todayDate)
    let items = this.all()
    if (options.status && options.status !== 'all') items = items.filter((it) => it.status === options.status)
    if (options.proj && options.proj !== 'all') items = items.filter((it) => (it.proj ?? '未归类') === options.proj)
    if (options.who && options.who !== 'all') items = items.filter((it) => it.who === options.who)
    const defaultView = !options.all
    if (defaultView) {
      items = items.filter((it) => {
        if (done(it)) return false
        if (isOverdue(it) || isToday(it)) return true
        if (isRepeatToday(it)) return true
        if (it.quadrant === 'q1' || it.quadrant === 'q2') return true
        return false
      })
    }
    const rank = (it) => (isOverdue(it) ? 0 : isToday(it) ? 1 : isRepeatToday(it) ? 2 : it.quadrant === 'q1' ? 3 : it.quadrant === 'q2' ? 4 : 5)
    items.sort((a, b) => {
      const r = rank(a) - rank(b)
      if (r !== 0) return r
      return String(a.due ?? '').localeCompare(String(b.due ?? ''))
    })
    const total = items.length
    const truncated = !options.all && items.length > this.maxListView
    if (!options.all) items = items.slice(0, this.maxListView)
    return { items, total, truncated, defaultView }
  }
  formatList(result) {
    const { items, total, truncated, defaultView } = result
    if (items.length === 0) {
      return defaultView ? '待办（默认视图）：没有需要关注的未完成待办，全部清空 🎉' : '待办：没有匹配的条目'
    }
    const head = defaultView ? `待办（默认视图：逾期/今日到期/今日周期/重要紧急，最多 ${this.maxListView} 条）` : `待办（${total} 条${truncated ? `，仅显示前 ${this.maxListView} 条` : ''}）`
    const lines = items.map((it) => {
      const tags = []
      if (it.quadrant) tags.push(`[${it.quadrant}]`)
      if (it.due !== null) tags.push(it.due < todayStamp() && it.status !== 'done' && it.status !== 'cancelled' ? `[逾期 ${it.due}]` : `[${it.due}]`)
      if (it.start !== null && it.due !== null && it.start !== it.due) tags.push(`[${it.start}→${it.due}]`)
      if (it.repeat) {
        tags.push(`[周期 ${repeatLabel(it.repeat, it.on)}]`)
        if (repeatMatches(it.repeat, it.on, new Date())) tags.push('[今天]')
      }
      if (it.proj) tags.push(`[${it.proj}]`)
      if (it.who) tags.push(`[负责人 ${it.who}]`)
      if (it.status !== 'pending') tags.push(`[${it.status}]`)
      return `- ${tags.join(' ')} ${it.content.split('\n')[0]}（id: ${it.id}）`
    })
    return `${head}\n${lines.join('\n')}\n操作按 id（todolist done/update/remove <id>）`
  }
}

// ---------------------------------------------------------------------------
// 插件配置（config.json）：模块开关 + 高级参数
// ---------------------------------------------------------------------------

/** 模块清单与默认开关（docs/requirements-v2.md §3.2）。 */
export const MODULE_DEFAULTS = {
  'core.list': true,
  'view.done': true,
  'core.search': true,
  'view.today': true,
  'view.calendar': true,
  'view.week': true,
  'view.project': true,
  'view.board': true,
  'feature.subtask': true,
  'feature.tags': true,
  'feature.reminder': true,
  'feature.importExport': true,
  'ai.write': false,
  'ai.search': false,
}

/** 预设档位（§3.3）。full = 全部视图与功能，仅 AI 工具需手动开启。 */
export const PRESET_MODULES = {
  minimal: ['core.list'],
  standard: ['core.list', 'view.done', 'core.search', 'view.today', 'feature.subtask', 'feature.tags', 'feature.importExport'],
  full: Object.keys(MODULE_DEFAULTS).filter((id) => !id.startsWith('ai.')),
}

const CONFIG_DEFAULTS = {
  preset: 'full',
  modules: MODULE_DEFAULTS,
  search: { debounceMs: 300, scope: 'all' },
  board: { groupBy: 'status' },
  subtask: { autoCompleteParent: false },
  tags: { maxPerTask: 8, maxLength: 20 },
  reminder: { offsets: [5, 15, 60, 540], quietHours: null, mergeWindowSec: 60 },
  io: { csvDelimiter: ',', csvBom: true },
  perf: { virtualList: false, virtualThreshold: 200 },
}

const REMINDER_OFFSETS = [5, 15, 60, 540]

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isInteger(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 按模块开关反推预设；不是任何预设的精确定义 → custom。 */
function detectPreset(modules) {
  for (const [preset, ids] of Object.entries(PRESET_MODULES)) {
    const expected = new Set(ids)
    const actual = Object.entries(modules).filter(([, on]) => on).map(([id]) => id)
    if (actual.length === expected.size && actual.every((id) => expected.has(id))) return preset
  }
  return 'custom'
}

/** 归一化任意配置输入：补默认值、夹取数值、剔除非法枚举；永不抛错。 */
export function normalizeConfig(raw) {
  const src = isPlainObject(raw) ? raw : {}
  const presetGiven = ['minimal', 'standard', 'full'].includes(src.preset)
  const rawModules = isPlainObject(src.modules) ? src.modules : null
  const modules = {}
  // 只给 preset 不给 modules → 以预设为模块集；否则以 modules 为准（缺项用默认）
  const presetSet = presetGiven ? new Set(PRESET_MODULES[src.preset]) : null
  for (const [id, fallback] of Object.entries(MODULE_DEFAULTS)) {
    if (rawModules !== null) {
      modules[id] = typeof rawModules[id] === 'boolean' ? rawModules[id] : fallback
    } else if (presetSet !== null) {
      modules[id] = presetSet.has(id)
    } else {
      modules[id] = fallback
    }
  }
  modules['core.list'] = true // 强制开启，插件根基

  const search = isPlainObject(src.search) ? src.search : {}
  const board = isPlainObject(src.board) ? src.board : {}
  const subtask = isPlainObject(src.subtask) ? src.subtask : {}
  const tags = isPlainObject(src.tags) ? src.tags : {}
  const reminder = isPlainObject(src.reminder) ? src.reminder : {}
  const io = isPlainObject(src.io) ? src.io : {}
  const perf = isPlainObject(src.perf) ? src.perf : {}

  const offsets = Array.isArray(reminder.offsets)
    ? [...new Set(reminder.offsets.map(Number).filter((n) => REMINDER_OFFSETS.includes(n)))].sort((a, b) => a - b)
    : [...CONFIG_DEFAULTS.reminder.offsets]

  const normalized = {
    preset: detectPreset(modules), // 档位始终由实际模块集反推，避免与开关不一致
    modules,
    search: {
      debounceMs: clampInt(search.debounceMs, 100, 1000, 300),
      scope: ['all', 'title', 'tag'].includes(search.scope) ? search.scope : 'all',
    },
    board: {
      groupBy: ['status', 'project'].includes(board.groupBy) ? board.groupBy : 'status',
    },
    subtask: {
      autoCompleteParent: subtask.autoCompleteParent === true,
    },
    tags: {
      maxPerTask: clampInt(tags.maxPerTask, 1, 20, 8),
      maxLength: clampInt(tags.maxLength, 1, 50, 20),
    },
    reminder: {
      offsets,
      quietHours: typeof reminder.quietHours === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(reminder.quietHours)
        ? reminder.quietHours
        : null,
      mergeWindowSec: clampInt(reminder.mergeWindowSec, 0, 300, 60),
    },
    io: {
      csvDelimiter: [',', ';', '\t'].includes(io.csvDelimiter) ? io.csvDelimiter : ',',
      csvBom: io.csvBom !== false,
    },
    perf: {
      virtualList: perf.virtualList === true,
      virtualThreshold: clampInt(perf.virtualThreshold, 50, 2000, 200),
    },
  }
  return normalized
}

/** 深合并（用于 PUT 局部更新），仅合并对象层级。 */
function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = mergeConfig(base[key], value)
    else if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * 配置文件读写：<dataDir>/config.json，原子写（tmp + rename）。
 * 读取失败（缺失/损坏）时回退默认配置，不阻断插件加载。
 */
export function createConfigStore(filePath) {
  let cached = null
  const read = () => {
    if (cached !== null) return cached
    try {
      cached = normalizeConfig(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[dsh-todolist] 配置读取失败，回退默认值：', error?.message ?? error)
      }
      cached = normalizeConfig({})
    }
    return cached
  }
  const save = (patch) => {
    const merged = mergeConfig(read(), patch)
    // 只改档位、没显式传 modules 时，丢弃继承来的 modules，让预设决定模块集
    if (isPlainObject(patch) && patch.preset !== undefined && patch.modules === undefined) {
      delete merged.modules
    }
    const next = normalizeConfig(merged)
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(next, null, 2))
    renameSync(tmp, filePath)
    cached = next
    return next
  }
  return { filePath, read, save }
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------

async function readBody(req, maxBytes = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  return JSON.parse(text)
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function installApi(ctx, deps) {
  const { store, config, configStore } = deps
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === '/todolist/api/config') {
        sendJson(res, 200, { config: configStore.read(), modules: MODULE_DEFAULTS, presets: PRESET_MODULES })
        return
      }

      if ((method === 'PUT' || method === 'POST') && path === '/todolist/api/config') {
        const body = await readBody(req)
        const patch = isPlainObject(body?.config) ? body.config : body
        const next = configStore.save(patch)
        sendJson(res, 200, { ok: true, config: next })
        return
      }

      if (method === 'GET' && path === '/todolist/api/todo') {
        const all = url.searchParams.get('all') === '1'
        const status = url.searchParams.get('status') || undefined
        const proj = url.searchParams.get('proj') || undefined
        const who = url.searchParams.get('who') || undefined
        const result = store.list({ all, status, proj, who })
        // 字段映射：存储用 content/createdAt，前端 TodoView 用 text/time
        const items = result.items.map((it) => ({ ...it, text: it.content, time: it.createdAt }))
        sendJson(res, 200, { items, total: result.total, truncated: result.truncated, defaultView: result.defaultView })
        return
      }

      if (method === 'POST' && path === '/todolist/api/todo') {
        const body = await readBody(req)
        const action = String(body?.action ?? '')
        if (action === 'add') {
          // 校验统一在 store.add 内（content/日期/repeat/on/quadrant/status）
          const outcome = store.add({
            content: body.content,
            proj: body.proj,
            who: body.who,
            start: body.start,
            due: body.due,
            dueTime: body.dueTime,
            repeat: body.repeat,
            on: body.on,
            quadrant: body.quadrant,
            parentId: body.parentId,
            tags: body.tags,
          })
          sendJson(res, outcome.ok ? 200 : 400, outcome)
          return
        }
        const id = String(body?.id ?? '').trim()
        if (!id) { sendJson(res, 400, { ok: false, message: 'id 不能为空' }); return }
        if (action === 'done') { const o = store.done(id); sendJson(res, o.ok ? 200 : 400, o); return }
        if (action === 'remove') { const o = store.remove(id, { cascade: body.cascade !== false }); sendJson(res, o.ok ? 200 : 400, o); return }
        if (action === 'renameTag') {
          const o = store.renameTag(body.from, body.to)
          sendJson(res, o.ok ? 200 : 400, o)
          return
        }
        if (action === 'removeTag') {
          const o = store.removeTag(body.tag)
          sendJson(res, o.ok ? 200 : 400, o)
          return
        }
        if (action === 'reorder') {
          const targetId = String(body?.targetId ?? '').trim()
          const position = String(body?.position ?? '').trim().toLowerCase()
          const o = store.reorder(id, targetId, position)
          sendJson(res, o.ok ? 200 : 400, o)
          return
        }
        if (action === 'update') {
          const patch = {}
          for (const key of ['content', 'proj', 'who', 'start', 'due', 'dueTime', 'repeat', 'on', 'quadrant', 'status', 'parentId', 'tags']) {
            if (body[key] !== undefined) patch[key] = body[key]
          }
          const o = store.update(id, patch)
          sendJson(res, o.ok ? 200 : 400, o)
          return
        }
        sendJson(res, 400, { ok: false, message: `未知操作 "${action}"` })
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: '/todolist', handler })
}

// ---------------------------------------------------------------------------
// AI 工具
// ---------------------------------------------------------------------------

/** `todolist` 工具：操作待办（add/list/done/update/remove）。 */
export function todoToolDefinition(config, store) {
  return {
    name: config.toolName,
    description: '待办管理（独立待办看板）。用户口述"记住/我要做 X"时用 add 直写（用户即确认者）。**list 默认智能视图**：只返回需要关注的未完成项（逾期/今日到期/今日周期/重要紧急，最多 8 条），看全部需显式 all=true 或筛选参数。每条待办支持：proj=项目（项目名称由任务数据决定）、who=负责人、due=截止日期、start=开始日期（与 due 组成时间跨度）、repeat=周期（daily/weekly/monthly，可配 on 定点：weekly 填 1-7=周几、monthly 填 1-31=几号；周期任务完成后自动推进到下一截止）、quadrant=四象限（q1-q4）、status=状态。done/update/remove 按 id 精确操作（list 输出带 id）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'done', 'update', 'remove'], description: 'add=新增；list=查看（默认智能视图）；done=完成（周期任务自动推进）；update=修改；remove=删除' },
        content: { type: 'string', description: 'add 时必填：待办内容（首行是标题，可多行）；update 时=替换内容' },
        proj: { type: 'string', description: '项目归属（如 设计/开发/运营；update 传空字符串清除）' },
        who: { type: 'string', description: '负责人（如 张三/李四；update 传空字符串清除）' },
        start: { type: 'string', description: '开始日期 YYYY-MM-DD（与 due 组成时间跨度；update 传空字符串清除）' },
        due: { type: 'string', description: '截止日期 YYYY-MM-DD（update 传空字符串清除）' },
        repeat: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: '周期循环：daily 每天 / weekly 每周 / monthly 每月（update 传空字符串清除）' },
        on: { type: 'string', description: '周期定点（配合 repeat）：weekly 填 1-7=周几、monthly 填 1-31=几号（update 传空字符串清除）' },
        quadrant: { type: 'string', enum: ['q1', 'q2', 'q3', 'q4'], description: '四象限：q1 重要紧急 / q2 重要不紧急 / q3 紧急不重要 / q4 不重要不紧急' },
        status: { type: 'string', enum: STATUSES, description: 'list 筛选（缺省=智能视图）；update 设置新状态' },
        id: { type: 'string', description: '条目标识（list 返回）；done/update/remove 必填' },
        all: { type: 'boolean', description: 'list 时 true=显示全部未过滤' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args) {
      const action = args.action
      if (action === 'add') {
        // 校验统一在 store.add 内（content/日期/repeat/on/quadrant/status）
        const outcome = store.add({
          content: args.content,
          proj: args.proj,
          who: args.who,
          start: args.start,
          due: args.due,
          repeat: args.repeat,
          on: args.on,
          quadrant: args.quadrant,
        })
        return { ok: outcome.ok, message: outcome.message, id: outcome.id }
      }
      if (action === 'list') {
        const result = store.list({
          all: args.all === true,
          status: args.status,
          proj: args.proj,
          who: args.who,
        })
        return { ok: true, message: store.formatList(result) }
      }
      const id = String(args.id ?? '')
      if (!id) return { ok: false, message: 'id 不能为空' }
      if (action === 'done') {
        const outcome = store.done(id)
        return { ok: outcome.ok, message: outcome.message }
      }
      if (action === 'remove') {
        const outcome = store.remove(id)
        return { ok: outcome.ok, message: outcome.message }
      }
      if (action === 'update') {
        const patch = {}
        for (const key of ['content', 'proj', 'who', 'start', 'due', 'repeat', 'on', 'quadrant', 'status']) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        const outcome = store.update(id, patch)
        return { ok: outcome.ok, message: outcome.message }
      }
      return { ok: false, message: `未知 action "${action}"` }
    },
  }
}

// ---------------------------------------------------------------------------
// 快照（注入模型上下文）
// ---------------------------------------------------------------------------

export function renderUsage(config) {
  return [
    `## 待办（dsh-todolist 插件）`,
    `- 管理：用户口述"记住/我要做 X"用 ${config.toolName} add 直写（用户即确认者）。`,
    `- 收尾检查：每轮收尾调用 ${config.toolName} list 检查到期（默认视图：逾期/今日到期/今日周期/重要紧急，最多 8 条）——有到期未完成项就在回复末尾提醒用户；不要主动展开全部待办清单，除非用户询问。`,
    `- 属性：proj=项目（项目选项来自已有任务数据）、who=负责人、due=截止、start=开始（与 due 组成时间跨度）、repeat=周期（daily/weekly/monthly，可配 on 定点）、quadrant=四象限、status=状态。`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  // v2 配置（模块开关 + 高级参数），与任务数据同目录、分离文件；任务存储读取标签限制
  const configStore = createConfigStore(join(config.dataDir, 'config.json'))
  const store = new TodoStore(join(config.dataDir, 'todos.json'), config.maxListView, configStore)

  // AI 工具
  ctx.effect(() => ctx.tools.register(todoToolDefinition(config, store)), 'dsh-todolist: todo tool')

  // 快照注入
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'todolist:usage',
    order: config.snapshotOrder,
    text: () => renderUsage(config),
  }), 'dsh-todolist: usage snapshot')

  // Web API
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => installApi(webCtx, { store, config, configStore }), 'dsh-todolist: web api')
  })
}
