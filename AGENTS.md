# AGENTS.md — dsh-session-search-plus

DSH 会话搜索框增强插件（宿主 + 浏览器双端）。工作区通用规则见上级
`../AGENTS.md`（遮蔽语义、构建自检、profile 硬链接校验等），这里只记本仓
特有的坑。

## 结构

- `src/index.ts`：宿主半区——内存内容索引（仅 user/assistant 文本块）+
  `POST /api/search-plus/query`。宿主改动**重启 dsh 才生效**，页面刷新只换前端。
- `src/doc-scan.ts`：文档提取。`eventSearchText`（单个逻辑事件）与
  `scanRawArtifact`（逐字工件全文）共用一套规则，两条路径必须等价。
- `src/doc-cache.ts`：持久化文档缓存（codec / 对账 planner / 路径解析 /
  原子写）。纯逻辑，全部可单测。
- `src/client/workspace-browser.js`：官方 `@deepseek-ai/dsh-client-ui-workspace@0.1.0-rc.6`
  编译产物的整体移植 fork，未改区域与官方逐字节一致，改动一律打 `// [search-plus]`
  标记。官方升级后需按新基线重做移植。
- `src/client/matcher.ts` / `filters.ts` / `highlight.ts`：可单测的纯逻辑
  （匹配/过滤规则/页内标记），新逻辑优先进这三个文件并进 tests/。

## 关键契约

- 跳转定位走 `data-chat-anchor-key` ↔ `session.snapshotCache.chat` 的
  anchorSeq===事件 seq，禁止退回文本指纹猜测（重复文本/折叠行会失配）。
- context 注入行官方折叠渲染（DisclosureRow），正文只在展开后进 DOM——
  跳转遇到折叠行先展开再标记。
- fuzzy（子序列）命中的文本可能不含连续查询串，DOM 里无串可标——
  所以 fuzzy 默认关；开着时散列命中只滚动不高亮。
- 宿主索引只认 `user/message`、`assistant/message` 的 text 块；
  同会话相同摘要的命中去重（重复注入的 context 只留首条）。
- **启动读取走 `readRaw`（逐字工件）而非 `inspect`（逻辑事件）**。依据：JSONL
  写入器只把 `assistant/chunk` 连续 delta 打包成 `text-chunks`/
  `reasoning-chunks`/`tool-call-chunks` 存储行（`dsh-session/chunk-rows` 的
  `packChunkRuns`：`if (event.type !== "assistant/chunk") return undefined`），
  消息行永远逐字整行落盘。逻辑读会把这些行拆回逐个事件——本机实测 23.2 万物理行
  拆成 179 万逻辑事件，而索引一个都不需要（`readRaw` 3.97s vs `inspect` 11.1s，
  文档逐字节一致）。
  **harness 升级检查项**：若上游把消息行也纳入打包白名单，此假设失效——
  `tests/doc-scan.spec.ts` 里"payload mimics a message"那条对抗测试会红，
  应急开关是宿主 config `rawScan: false`（强制回退 `inspect`）。
- **不要用 `readFrom(id, fromSeq)` 做增量**：顺序介质（JSONL）无论 `fromSeq`
  取多少都要解析整个工件，实测 14.9–17.7s，比全量 `inspect` 更慢。增量只能
  **按会话跳过**（revision 比对），不能按 seq 跳过。
- 缓存键是持久化 revision（JSONL 为 `dev:ino:size:mtimeNs:ctimeNs`，stat 派生、
  跨重启稳定）。revision 变了就整会话重提取，不做 seq 水位。
- **缓存绝不收活跃会话经实时 feed 得到的文档**：内存文档可能领先已落盘日志
  （事件已提交但未 flush），按当时 revision 存下会让后续启动信任一条日志里
  不存在的 seq，跳转锚点随即失配。只存"先读 revision、再读工件"的自洽配对。
- 缓存语义对齐官方 projection-cache：可能过期但绝不出错；损坏/版本不符/写失败
  一律 fail-soft 退回冷建，删除缓存文件永远安全。

## 验证

`pnpm test` + `pnpm bundle` + `grep` 产物自检 + profile 硬链接校验
（`~/.dsh/profiles/web/node_modules/dsh-session-search-plus/lib/`）。

启动路径改动后必须补三项实测（可用 `Context` 直接挂 `dsh-session` +
`dsh-session-persistence-jsonl` + 本插件 lib 产物，指定 `cachePath` 到 /tmp）：

1. 冷/热启动两轮日志（`content index ready` 行的复用/重读计数与耗时）；
2. 新旧路径**结果等价**：同一批 query × 全部模式组合（大小写/全词/正则/模糊）
   逐字节比对 `index.query()` 输出；
3. 失效路径：改一条 revision（应只重读 1 个）、注入不存在的会话（应 dropped）、
   写坏字节（应冷建）、`version` 改高（应丢弃）、缓存路径不可写（应 warn 但建成）。
DOM/时序类行为用 Playwright 连 `http://127.0.0.1:3080` 实测（先例见
git 历史中的探针记录）。
