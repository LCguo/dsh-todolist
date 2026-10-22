# dsh-todolist（本地化 v2）

DeepSeek Harness 的独立待办看板插件。v2 在 v0.2.1 基础上做了**可配置化改造**，并补齐子任务、标签、搜索、三列看板、到期提醒、导入导出与 AI 工具拆分。

> 需求全文与验收标准见 `docs/requirements-v2.md`。

## 功能一览

| 模块 | 说明 | 默认 |
|---|---|---|
| 列表 | 未完成按「逾期 → 截止 → 创建」排序；已完成按配置归入已办或置底 | 开（强制） |
| 已办 | 已完成/已取消集中展示，按完成时间倒序 | 开 |
| 搜索 | 顶部搜索，防抖 300ms；多关键词 AND；`#标签` / `@项目`；命中高亮 | 开 |
| 今日 | 逾期、今日到期、周期任务 | 开 |
| 日历 / 周 | 月视图、周泳道，支持拖拽改期与排序 | 开 |
| 项目看板 | 横向项目列 | 开 |
| 三列看板 | 待办/进行中/已完成；可切换按项目分组；拖拽改状态或项目，列内拖拽排序；`Alt+←/→` 键盘移动 | 开 |
| 子任务 | 仅一层，只在父任务详情内展示与勾选；父任务显示 `1/3` 进度；删除父任务级联 | 开 |
| 标签 | 多标签、去重、自动补全、多选筛选；设置页可全局重命名/删除（无颜色） | 开 |
| 到期提醒 | 提前 5/15/60 分钟、当天 9 点；去重、免打扰、合并通知 | 开 |
| 导入导出 | 导出 JSON/CSV；导入 JSON（合并/替换），自动备份，导入前预览 | 开 |
| AI 写工具 | `todo_add` `todo_update` `todo_done` `todo_remove` `todo_list` | **关** |
| AI 只读查询 | `todo_search`（无任何写副作用） | **关** |

## 配置

配置存于 `<DSH_HOME>/todo-data/config.json`，与任务数据分离。面板右上角「⚙」打开设置：

- **预设档位**：极简（仅列表）/ 标准 / 完整
- **模块开关**：上表 14 个模块逐项开关（`core.list` 强制开启）
- **高级参数**：搜索防抖、标签数量/长度上限、看板默认分组、虚拟列表与阈值
- **标签管理**：全局重命名、删除
- **导入导出**：见上

配置保存后立即生效；AI 工具开关会即时注册/注销工具。

## AI 工具

默认全部关闭（MCP 工具列表中不出现）。在设置中开启后：

- `todo_add` — 新增任务/子任务（content 必填，支持 proj/who/start/due/dueTime/repeat/on/quadrant/tags/parentId）
- `todo_update` — 修改字段（传空字符串清除）
- `todo_done` — 完成；`undone: true` 恢复
- `todo_remove` — 删除（默认级联子任务，`cascade: false` 可拒绝）
- `todo_list` — 查看（默认智能视图，`all: true` 看全部）
- `todo_search` — **只读**搜索，支持关键词/状态/项目/标签/日期范围/是否含子任务/limit

所有写操作追加审计日志：`<DSH_HOME>/todo-data/ai-audit.log`（超过 200KB 裁剪到最近 1000 行）。

## 数据与备份

| 文件 | 说明 |
|---|---|
| `<DSH_HOME>/todo-data/todos.json` | 任务（原子写：tmp + rename） |
| `<DSH_HOME>/todo-data/config.json` | 配置 |
| `<DSH_HOME>/todo-data/todos-backup-*.json` | 导入前自动备份，保留最近 5 份 |
| `<DSH_HOME>/todo-data/ai-audit.log` | AI 写操作审计 |

旧版（v0.2.1）`todos.json` 可被直接读取，加载时自动补齐 `parentId` / `tags` / `dueTime` / `reminderSent` / `updatedAt`。

## 开发

- 入口：`lib/index.js`（服务端：存储、HTTP API、AI 工具、快照）
- 前端：`lib/client.js`（单文件 bundle，可读、未压缩；含 UI/i18n/CSS）
- 样式追加层：`client.js` 里的 `extraStyles`（独立 style 标签注入，避免改动基础样式串）
- 测试：`npm test`（i18n 静态检查 + M1~M10 功能测试 + 5000 条压测）
- 压测：`npm run bench`

本地开发流程：修改 `lib/*.js` → 重启 DSH Desktop（客户端 bundle 在启动时加载）→ 验证。

## 已知边界

- 提醒只在 DSH 运行期间调度，关闭期间不补发（重新打开后只补「未过期」的提醒点）
- 系统通知依赖浏览器/Electron 的 `Notification` 权限；被拒绝时降级为控制台提示
- 虚拟列表为「分批渲染 + 滚动加载」，不是严格意义的 DOM 虚拟化
- 任务描述字段（`desc`）已在模型中预留，本期 UI 与搜索尚未使用

## License

MIT，版权归属见 [LICENSE](./LICENSE)。
