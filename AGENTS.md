# AGENTS.md — dsh-session-search-plus

DSH 会话搜索框增强插件（宿主 + 浏览器双端）。工作区通用规则见上级
`../AGENTS.md`（遮蔽语义、构建自检、profile 硬链接校验等），这里只记本仓
特有的坑。

## 结构

- `src/index.ts`：宿主半区——内存内容索引（仅 user/assistant 文本块）+
  `POST /api/search-plus/query`。宿主改动**重启 dsh 才生效**，页面刷新只换前端。
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

## 验证

`pnpm test` + `pnpm bundle` + `grep` 产物自检 + profile 硬链接校验
（`~/.dsh/profiles/web/node_modules/dsh-session-search-plus/lib/`）。
DOM/时序类行为用 Playwright 连 `http://127.0.0.1:3080` 实测（先例见
git 历史中的探针记录）。
