// M7 自测：提醒已发送标记（去重）与 dueTime 计算基准
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-m7-'))
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

const withTime = store.add({ content: '有时间的任务', due: '2026-11-02', dueTime: '09:30' })
const noTime = store.add({ content: '无时间的任务', due: '2026-11-02' })

console.log('提醒基准时间')
const at = (item) => new Date(`${item.due}T${item.dueTime ?? '23:59'}:00`).getTime()
const itemA = store.findById(withTime.id)
const itemB = store.findById(noTime.id)
check('有 dueTime 用 09:30', new Date(at(itemA)).getHours() === 9 && new Date(at(itemA)).getMinutes() === 30)
check('无 dueTime 回退 23:59', new Date(at(itemB)).getHours() === 23 && new Date(at(itemB)).getMinutes() === 59)

console.log('已发送标记')
check('初始为空', store.findById(withTime.id).reminderSent === null)
store.markReminder(withTime.id, 15, '2026-11-02T09:15:00.000Z')
check('记录 offset=15', store.findById(withTime.id).reminderSent['15'] === '2026-11-02T09:15:00.000Z', store.findById(withTime.id).reminderSent)
store.markReminder(withTime.id, 5, '2026-11-02T09:25:00.000Z')
check('多提醒点共存', Object.keys(store.findById(withTime.id).reminderSent).length === 2)
check('不存在的 id 拒绝', store.markReminder('nope', 5, 'x').ok === false)

console.log('时间变更后重置')
store.update(withTime.id, { dueTime: '10:00' })
check('改 dueTime 清空 reminderSent', store.findById(withTime.id).reminderSent === null)
store.markReminder(withTime.id, 60, 'x')
store.update(withTime.id, { due: '2026-11-05' })
check('改 due 清空 reminderSent', store.findById(withTime.id).reminderSent === null)

console.log('已完成任务不再提醒（调度层过滤依据）')
store.done(noTime.id)
check('doneAt 已写入', store.findById(noTime.id).status === 'done')

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
