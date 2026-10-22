// M2 自测：数据模型升级（parentId / tags / dueTime / reminderSent / updatedAt）与旧数据迁移
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-m2-'))
const file = join(dir, 'todos.json')
const configStore = createConfigStore(join(dir, 'config.json'))
const store = new TodoStore(file, 8, configStore)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

console.log('旧数据迁移（v0.2.1 无新字段）')
const legacyDir = mkdtempSync(join(tmpdir(), 'todo-m2-legacy-'))
const legacyFile = join(legacyDir, 'todos.json')
writeFileSync(legacyFile, JSON.stringify({
  version: 1,
  items: [{
    id: 'aaaa1111', content: '旧任务', proj: null, who: null,
    start: null, due: '2026-12-01', repeat: null, on: null,
    quadrant: null, status: 'pending', createdAt: '2026-09-01 09:00',
    doneAt: null, last: null, calendarOrder: 0,
  }],
}))
const legacyStore = new TodoStore(legacyFile, 8, configStore)
const migrated = legacyStore.all()[0]
check('parentId 补 null', migrated.parentId === null, migrated.parentId)
check('tags 补空数组', Array.isArray(migrated.tags) && migrated.tags.length === 0)
check('dueTime 补 null', migrated.dueTime === null)
check('reminderSent 补 null', migrated.reminderSent === null)
check('updatedAt 回填 createdAt', migrated.updatedAt === '2026-09-01 09:00', migrated.updatedAt)
check('迁移已落盘', JSON.parse(readFileSync(legacyFile, 'utf8')).items[0].parentId === null)

console.log('新增与子任务')
const parent = store.add({ content: '父任务', due: '2026-11-01', tags: ['工作', '工作', ' Work ', ''] })
check('父任务创建成功', parent.ok, parent.message)
const parentItem = store.findById(parent.id)
check('标签去重且保留首次写法', JSON.stringify(parentItem.tags) === '["工作","Work"]', parentItem.tags)

const child = store.add({ content: '子任务1', parentId: parent.id })
check('子任务创建成功', child.ok, child.message)
const grandchild = store.add({ content: '孙任务', parentId: child.id })
check('禁止二层子任务', grandchild.ok === false && /一层/.test(grandchild.message), grandchild.message)
const orphan = store.add({ content: '孤儿', parentId: 'not-exist' })
check('父任务不存在被拒绝', orphan.ok === false, orphan.message)

console.log('标签限制')
store.limits() // 读默认
const many = store.add({ content: '标签超量', tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'] })
check('超过 8 个被截断', store.findById(many.id).tags.length === 8, store.findById(many.id).tags.length)
const long = store.add({ content: '超长标签', tags: ['x'.repeat(30)] })
check('超长标签被截断到 20', store.findById(long.id).tags[0].length === 20)
configStore.save({ tags: { maxPerTask: 3, maxLength: 10 } })
const limited = store.add({ content: '配置生效', tags: ['a', 'b', 'c', 'd'] })
check('配置 maxPerTask=3 生效', store.findById(limited.id).tags.length === 3, store.findById(limited.id).tags)

console.log('dueTime 校验')
const okTime = store.add({ content: '有时间的任务', due: '2026-11-02', dueTime: '09:30' })
check('合法 dueTime 接受', okTime.ok, okTime.message)
check('dueTime 落库', store.findById(okTime.id).dueTime === '09:30')
const badTime = store.add({ content: '非法时间', due: '2026-11-02', dueTime: '25:99' })
check('非法 dueTime 拒绝', badTime.ok === false, badTime.message)
const badTime2 = store.add({ content: '非法时间2', due: '2026-11-02', dueTime: '9:30' })
check('单位数小时拒绝', badTime2.ok === false, badTime2.message)

console.log('更新语义')
const before = store.findById(okTime.id)
await new Promise((r) => setTimeout(r, 5))
store.update(okTime.id, { content: '改名后' })
const after = store.findById(okTime.id)
check('updatedAt 刷新', after.updatedAt !== before.updatedAt)
check('reminderSent 因 due 变更重置', after.reminderSent === null)

// 手动塞一个已发送记录，再改 due 验证重置
const raw = JSON.parse(readFileSync(file, 'utf8'))
raw.items.find((it) => it.id === okTime.id).reminderSent = { 5: '2026-11-02 09:25' }
writeFileSync(file, JSON.stringify(raw))
store.update(okTime.id, { due: '2026-11-03' })
check('改 due 后 reminderSent 清空', store.findById(okTime.id).reminderSent === null)

console.log('级联删除')
const cascadeParent = store.add({ content: '带子任务的父任务' })
const c1 = store.add({ content: '子1', parentId: cascadeParent.id })
const c2 = store.add({ content: '子2', parentId: cascadeParent.id })
const refuse = store.remove(cascadeParent.id, { cascade: false })
check('未显式 cascade 时拒绝删除', refuse.ok === false && /子任务/.test(refuse.message), refuse.message)
const removed = store.remove(cascadeParent.id)
check('默认级联删除', removed.ok && removed.removed === 3, removed)
check('子任务已一并删除', store.findById(c1.id) === null && store.findById(c2.id) === null)

console.log('父任务约束')
const noParent = store.add({ content: '独立任务' })
store.update(c1.id, { parentId: noParent.id })
check('已删除的子任务无法更新', store.findById(c1.id) === null)
const parentWithChild = store.add({ content: '有子任务' })
store.add({ content: '它的子任务', parentId: parentWithChild.id })
const toChild = store.update(parentWithChild.id, { parentId: noParent.id })
check('有子任务的任务不能变成子任务', toChild.ok === false, toChild.message)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
