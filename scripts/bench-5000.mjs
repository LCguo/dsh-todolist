// M10 压测：5000 条任务下的读取、列表、CSV 导出、JSON 导入耗时
import { mkdtempSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-bench-'))
const file = join(dir, 'todos.json')
const configStore = createConfigStore(join(dir, 'config.json'))
const store = new TodoStore(file, 8, configStore)

const TODAY = new Date()
const stamp = (offset) => {
  const d = new Date(TODAY.getTime() + offset * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

console.log('构造 5000 条任务…')
const items = []
for (let i = 0; i < 5000; i++) {
  items.push({
    id: `id${String(i).padStart(6, '0')}`,
    content: `任务 ${i}：${['周报整理', '客户回访', '需求评审', '代码审查', '数据核对'][i % 5]} #${i}`,
    proj: ['项目A', '项目B', '项目C', ''][i % 4],
    who: ['张三', '李四', ''][i % 3],
    start: null,
    due: stamp((i % 30) - 10),
    dueTime: i % 4 === 0 ? '18:00' : null,
    repeat: null,
    on: null,
    quadrant: ['q1', 'q2', 'q3', 'q4', null][i % 5],
    status: ['pending', 'doing', 'done', 'pending', 'pending'][i % 5],
    parentId: null,
    tags: i % 3 === 0 ? ['工作', `批次${i % 10}`] : [],
    reminderSent: null,
    createdAt: '2026-01-01 09:00',
    updatedAt: '2026-01-01T09:00:00.000Z',
    doneAt: ['pending', 'doing', 'done'][i % 3] === 'done' ? '2026-01-02 10:00' : null,
    last: null,
    calendarOrder: i,
  })
}
writeFileSync(file, JSON.stringify({ version: 1, items }, null, 2))
console.log(`文件大小：${(statSync(file).size / 1024 / 1024).toFixed(2)} MB`)

const measure = (label, fn, budgetMs) => {
  const t0 = performance.now()
  const result = fn()
  const ms = performance.now() - t0
  const ok = budgetMs === undefined || ms <= budgetMs
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${ms.toFixed(1)} ms${budgetMs === undefined ? '' : `（预算 ${budgetMs} ms）`}`)
  return { ms, ok, result }
}

let failures = 0
const run = (label, fn, budget) => {
  const outcome = measure(label, fn, budget)
  if (!outcome.ok) failures++
  return outcome.result
}

console.log('读取与查询')
run('冷启动读取全部（含模型迁移）', () => store.all(), 800)
run('热读取全部', () => store.all(), 300)
run('智能视图 list()', () => store.list({ all: false }), 100)
run('全量 list(all)', () => store.list({ all: true }), 200)
run('按状态筛选', () => store.list({ all: true, status: 'pending' }), 100)

console.log('导出与导入')
run('CSV 导出', () => store.exportCsv(','), 400)
run('JSON 导出', () => store.exportData(), 200)
const dump = store.exportData()
run('JSON 导入（替换 5000 条）', () => store.importData(dump, 'replace'), 1500)

console.log('单条写入（节流前基线）')
run('更新单条', () => store.update('id000000', { status: 'doing' }), 300)
run('新增单条', () => store.add({ content: '压测新增任务' }), 300)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} 项超出预算`}`)
process.exit(failures === 0 ? 0 : 1)
