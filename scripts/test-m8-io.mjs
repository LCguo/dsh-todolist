// M8 自测：JSON/CSV 导出、JSON 导入（合并/替换）、备份、非法数据与父子校验
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-m8-'))
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

const parent = store.add({ content: '任务,带逗号', tags: ['工作'], due: '2026-12-01', dueTime: '09:30' })
const child = store.add({ content: '子任务', parentId: parent.id })

console.log('JSON 导出')
const exported = store.exportData()
check('schemaVersion=2', exported.schemaVersion === 2)
check('包含全部任务', exported.tasks.length === 2)
check('保留标签', Array.isArray(exported.tasks[0].tags))

console.log('CSV 导出')
const csv = store.exportCsv(',')
const lines = csv.split('\r\n')
check('表头包含标题/正文', lines[0].startsWith('id,parentId,title,body,status'), lines[0])
check('逗号内容被引号包裹', lines.some((line) => line.includes('"任务,带逗号"')), lines[1])
check('标签用 | 分隔', lines.some((line) => line.includes('工作')))
check('子任务行 parentId 指向父任务', lines.some((line) => line.includes(`,${parent.id},`)))

console.log('导入（合并）')
const imported = store.importData({
  schemaVersion: 2,
  tasks: [
    { id: parent.id, content: '任务（改名）', status: 'doing', tags: ['新标签'] },
    { id: 'new00001', content: '新增任务', due: '2026-12-31' },
    { id: 'bad00001', text: '   ' },
    { id: 'orphan001', content: '父任务无效', parentId: 'not-exist' },
  ],
}, 'merge')
check('导入成功', imported.ok, imported)
check('覆盖 1 条', imported.overwritten === 1, imported)
check('新增 2 条', imported.added === 2, imported)
check('跳过 1 条空内容', imported.skipped === 1, imported)
check('父任务无效降级为顶层', store.findById('orphan001').parentId === null)
check('改名生效', store.findById(parent.id).content === '任务（改名）')
check('返回备份路径', typeof imported.backup === 'string' && imported.backup.includes('todos-backup'))
check('备份文件存在', readdirSync(dir).some((name) => name.startsWith('todos-backup')))

console.log('导入（替换）')
const replaced = store.importData({ tasks: [{ id: 'only0001', content: '唯一任务' }] }, 'replace')
check('替换成功', replaced.ok)
check('只剩 1 条', store.all().length === 1, store.all().length)
check('总数为 1', replaced.total === 1)

console.log('异常输入')
check('缺少 tasks 拒绝', store.importData({ foo: 1 }, 'merge').ok === false)
check('字符串 JSON 可导入', store.importData(JSON.stringify({ tasks: [{ content: '字符串导入' }] }), 'merge').ok === true)
check('超过 20000 条拒绝', store.importData({ tasks: Array.from({ length: 20001 }, (_, i) => ({ content: `t${i}` })) }, 'merge').ok === false)

console.log('往返一致性')
const roundDir = mkdtempSync(join(tmpdir(), 'todo-m8-round-'))
const roundConfig = createConfigStore(join(roundDir, 'config.json'))
const source = new TodoStore(join(roundDir, 'source.json'), 8, roundConfig)
source.add({ content: '往返任务', tags: ['a', 'b'], due: '2026-12-05' })
const dump = source.exportData()
const target = new TodoStore(join(roundDir, 'target.json'), 8, roundConfig)
target.importData(dump, 'replace')
check('导出再导入条数一致', target.all().length === source.all().length)
check('内容一致', target.all()[0].content === '往返任务')
check('标签一致', JSON.stringify(target.all()[0].tags) === '["a","b"]')

console.log('备份保留上限')
for (let i = 0; i < 7; i++) {
  store.importData({ tasks: [{ content: `bulk${i}` }] }, 'merge')
}
const backupCount = readdirSync(dir).filter((name) => name.startsWith('todos-backup')).length
check('备份最多保留 5 份', backupCount <= 5, backupCount)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
