// M9 自测：写工具拆分、只读搜索、审计日志、工具按开关启用
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TodoStore, createConfigStore, buildWriteTools, buildSearchTool, renderUsage } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'todo-m9-'))
const configStore = createConfigStore(join(dir, 'config.json'))
const store = new TodoStore(join(dir, 'todos.json'), 8, configStore)
const config = { dataDir: dir, maxListView: 8, toolName: 'todolist' }

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

console.log('工具清单')
const writeTools = buildWriteTools(config, store)
const names = writeTools.map((tool) => tool.name).sort()
check('五个写工具', JSON.stringify(names) === JSON.stringify(['todo_add', 'todo_done', 'todo_list', 'todo_remove', 'todo_update']), names)
const searchTool = buildSearchTool(store)
check('搜索工具名', searchTool.name === 'todo_search')

const byName = Object.fromEntries(writeTools.map((tool) => [tool.name, tool]))

console.log('写工具行为')
const added = await byName.todo_add.execute({ content: '写工具创建', tags: ['ai'], due: '2026-12-01' })
check('todo_add 成功', added.ok === true && typeof added.id === 'string', added)
const child = await byName.todo_add.execute({ content: '子任务', parentId: added.id })
check('todo_add 子任务', child.ok === true, child)
const updated = await byName.todo_update.execute({ id: added.id, proj: '项目A', status: 'doing' })
check('todo_update 成功', updated.ok === true)
check('更新已落库', store.findById(added.id).proj === '项目A' && store.findById(added.id).status === 'doing')
const doneOutcome = await byName.todo_done.execute({ id: added.id })
check('todo_done 成功', doneOutcome.ok === true)
check('状态 done', store.findById(added.id).status === 'done')
await byName.todo_done.execute({ id: added.id, undone: true })
check('undone 恢复', store.findById(added.id).status === 'pending')
const listed = await byName.todo_list.execute({ all: true })
check('todo_list 返回文本', listed.ok === true && typeof listed.message === 'string')

console.log('只读搜索')
const searchResult = await searchTool.execute({ query: '写工具' })
check('关键词命中', searchResult.total === 1, searchResult)
check('默认不含子任务', searchResult.items.every((item) => item.parentId === null))
const withChildren = await searchTool.execute({ query: '子任务', includeSubtasks: true })
check('includeSubtasks 含子任务', withChildren.items.some((item) => item.parentId !== null))
const byTag = await searchTool.execute({ tag: 'AI' })
check('标签大小写不敏感', byTag.total === 1, byTag)
const byDue = await searchTool.execute({ dueAfter: '2026-11-01', dueBefore: '2026-12-31' })
check('日期范围过滤', byDue.items.every((item) => item.due >= '2026-11-01' && item.due <= '2026-12-31'))
const limited = await searchTool.execute({ limit: 1 })
check('limit 生效', limited.items.length === 1)
check('返回精简字段', Object.keys(limited.items[0]).every((key) => ['id', 'title', 'body', 'text', 'status', 'proj', 'tags', 'due', 'dueTime', 'parentId'].includes(key)))

console.log('只读保证')
const before = readFileSync(join(dir, 'todos.json'), 'utf8')
const beforeMtime = statSync(join(dir, 'todos.json')).mtimeMs
await searchTool.execute({ query: '' })
await searchTool.execute({ status: 'pending' })
const after = readFileSync(join(dir, 'todos.json'), 'utf8')
check('搜索不修改数据文件', before === after)
check('搜索不刷新文件时间', statSync(join(dir, 'todos.json')).mtimeMs === beforeMtime)

console.log('审计日志')
const auditPath = join(dir, 'ai-audit.log')
check('写操作产生审计日志', existsSync(auditPath))
const auditLines = readFileSync(auditPath, 'utf8').trim().split('\n')
check('日志含 todo_add', auditLines.some((line) => line.includes('"tool":"todo_add"')))
check('日志含 todo_update', auditLines.some((line) => line.includes('"tool":"todo_update"')))
check('搜索不写审计', !auditLines.some((line) => line.includes('todo_search')))

console.log('删除级联')
const removeOutcome = await byName.todo_remove.execute({ id: added.id })
check('父任务级联删除', removeOutcome.ok === true && /子任务/.test(removeOutcome.message), removeOutcome)
check('子任务一并删除', store.findById(child.id) === null)

console.log('提示词只描述已开启能力')
const usageNone = renderUsage(config, { 'ai.write': false, 'ai.search': false })
check('未开启时提示去设置', usageNone.includes('未开启'))
const usageWrite = renderUsage(config, { 'ai.write': true, 'ai.search': false })
check('开启写工具后提到 todo_add', usageWrite.includes('todo_add'))
check('开启写工具后不含搜索', !usageWrite.includes('todo_search'))
const usageBoth = renderUsage(config, { 'ai.write': true, 'ai.search': true })
check('两者都开启', usageBoth.includes('todo_add') && usageBoth.includes('todo_search'))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
