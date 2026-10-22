// M4 自测：标签重命名 / 删除 / 大小写不敏感 / 合并去重
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-m4-'))
const configStore = createConfigStore(join(dir, 'config.json'))
const store = new TodoStore(join(dir, 'todos.json'), 8, configStore)

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const a = store.add({ content: '任务A', tags: ['工作', '紧急'] })
const b = store.add({ content: '任务B', tags: ['工作'] })
const c = store.add({ content: '任务C', tags: ['个人'] })
const d = store.add({ content: '任务D', tags: ['WORK'] }) // 大小写不敏感

console.log('重命名标签')
const renamed = store.renameTag('工作', '项目')
check('返回受影响数', renamed.affected === 2, renamed)
check('A 已改名', store.findById(a.id).tags.includes('项目'))
check('A 保留其它标签', store.findById(a.id).tags.includes('紧急'))
check('B 已改名', store.findById(b.id).tags.includes('项目'))
check('C 未受影响', JSON.stringify(store.findById(c.id).tags) === '["个人"]')

console.log('大小写不敏感')
const renamed2 = store.renameTag('work', 'work')
check('大小写变更也会归一（WORK → work）', renamed2.affected === 1, renamed2)
check('归一后为小写', JSON.stringify(store.findById(d.id).tags) === '["work"]', store.findById(d.id).tags)
const merged = store.renameTag('WORK', '个人')
check('改名后与已有标签合并去重', JSON.stringify(store.findById(d.id).tags) === '["个人"]', store.findById(d.id).tags)

// 上一步把 D 的标签改成了 work，先改回「个人」以便后续合并断言
store.renameTag('work', '个人')

console.log('删除标签')
const removed = store.removeTag('项目')
check('影响 2 个任务', removed.affected === 2, removed)
check('A 只剩紧急', JSON.stringify(store.findById(a.id).tags) === '["紧急"]', store.findById(a.id).tags)
check('B 标签清空', store.findById(b.id).tags.length === 0)

console.log('参数校验')
check('空原名拒绝', store.renameTag('', 'x').ok === false)
check('空新名拒绝', store.renameTag('x', '   ').ok === false)
check('空标签删除拒绝', store.removeTag('').ok === false)
configStore.save({ tags: { maxPerTask: 8, maxLength: 3 } })
check('改名超长被拒绝', store.renameTag('个人', '四个字符').ok === false, store.renameTag('个人', '四个字符'))

console.log('updatedAt 标记')
const raw = JSON.parse(JSON.stringify(store.findById(a.id)))
check('被重命名的任务有 updatedAt', typeof raw.updatedAt === 'string' && raw.updatedAt.length > 0)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
