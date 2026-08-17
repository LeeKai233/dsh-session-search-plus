# dsh-session-search-plus

English: [README.md](./README.md)

就地增强 DSH 官方侧栏搜索框：自建内存索引毫秒级检索，搜索交互对齐 VS Code。

## 行为

- **模式开关**（输入框右端，VS Code 同款）：`Aa` 大小写敏感、`ab` 全词匹配
  （开启后 `pnpm` 不再命中 `npm`）、`.*` 正则、`fz` 模糊子序列。`ab` 与 `.*`
  可叠加（模式串外加 `\b`）；`fz` 与 `ab` / `.*` 互斥。默认全部关闭（纯子串）。
- **结果展示**：命中词着色，摘要窗口与 VS Code 同算法（词边界前导 + 单行省略）。
  一个会话多处命中时行尾出现 `▾ N`，展开列出全部命中（≤8 条，相同摘要自动去重），
  多个下拉可同时展开。点选命中行变色（头部不亮），其下拉的层级线常驻；鼠标移入
  结果区时，其余展开下拉的层级线显现。
- **跳转高亮**：点击命中按事件 seq 精确定位——自动向前翻历史，折叠的上下文注入
  行会先展开再定位。所选命中滚动居中并填充高亮，本页其余命中框选。切换会话，
  或收起搜索后点击页面任意处，高亮即清除。
- **自建高速索引**：只索引 user / assistant 消息的文本块（注入的上下文也算
  user 消息；工具参数、结果、推理等噪声不索引），毫秒级响应，绕过官方引擎
  逐次 reconcile。

官方搜索框的展开动效、结果就地替换会话列表、Esc / 外点收起等行为保持不变。

## 使用

侧栏原来的搜索框就是入口，不用另开面板。

1. 点开搜索，默认按纯子串查标题（客户端）和内容（宿主索引）。
2. 需要时点输入框右端的 `Aa` / `ab` / `.*` / `fz`。`fz` 开着时页内通常无处可标，
   只滚动到命中附近。
3. 多命中会话点行尾 `▾ N` 展开，点某一条跳进该消息。
4. 读完后 Esc 或点搜索框外收起；再点页面任意处，填充高亮和框选消失。

## 架构

- **宿主半**（`src/index.ts`）：启动时从持久化服务全量构建内存索引，随后经
  `session/event` 增量更新（按 `(sessionId, seq)` 去重）；提供
  `POST /api/search-plus/query`（子串 / 模糊子序列 / 正则，大小写与全词开关，
  按会话分组的窗口化摘要与命中偏移）。宿主改动需重启 dsh 才生效。
- **浏览器半**（`src/client/`）：官方 `@deepseek-ai/dsh-client-ui-workspace@0.1.0-rc.6`
  的 WorkspaceBrowser 移植 fork。未改区域与官方产物逐字节一致，改动均以
  `// [search-plus]` 标记；官方升级后需按新基线重做移植。内容查询走
  `/api/search-plus/query`，标题匹配留在客户端。页面刷新只加载前端。

## 相关插件

官方索引的启动预热在兄弟插件 **dsh-session-search-warmup**：它在进程启动的
安静窗口内提交官方 SQLite FTS5 索引，让本插件不接管的官方搜索表面（窄栏模式、
回退路径）第一次查询即可用。两者互补、互不依赖。

## 安装

```sh
dsh plugin --profile web add dsh-session-search-plus
```

或手动：把本包加入 web profile 的 `dsh.profile.bundles`，安装依赖后重启 dsh web。

不要在 `~/.dsh/profiles/web/cordis.patch.yml` 里再插一条 `session-search-plus`
（loader 会因重复 insert id 拒绝启动）。本移植接管官方搜索槽位，profile 还需
停用官方 `ui-workspace` 行，见同一份 `cordis.patch.yml`。

## 验证

```sh
dsh --profile web --dump-config   # 应出现 session-search-plus 行
```

启动后观察宿主日志：

```
[search-plus] content index built: N docs from M sessions in Xms
```

随后在侧栏搜索框输入：出现带着色摘要与多命中下拉的内容结果，即接管成功。

## 卸载

```sh
dsh plugin --profile web remove dsh-session-search-plus
```

重启 dsh，并恢复 profile 里被停用的官方 `ui-workspace` 行，侧栏搜索即回到官方实现。

## 已知限制

- 深历史命中（例如几年老会话的开头）需按官方 50 条 / 页顺序翻页，可能要等十几秒
  才落位；浅命中秒到。
- `fz` 默认关：模糊子序列命中的文本里可能没有连续查询串，页内无处可标。
- 非法正则静默返回空结果（不做红框提示）。

## 开发

```sh
pnpm install
pnpm bundle
pnpm test
```
