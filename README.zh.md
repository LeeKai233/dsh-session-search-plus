# dsh-session-search-plus

就地增强 DSH 官方侧栏搜索框的插件（宿主 + 浏览器双端）：

- **就地增强官方搜索框**：浏览器端以官方
  `@deepseek-ai/dsh-client-ui-workspace@0.1.0-rc.6` 编译产物为基底整体移植
  WorkspaceBrowser/WorkspacePicker（profile 中停用官方 `ui-workspace` 行，
  见 `~/.dsh/profiles/web/cordis.patch.yml`）。展开动效、结果就地替换会话
  列表、Esc/外点收起等官方行为逐字节保留，仅搜索路径做外科手术：
  输入框右端 vscode 风格模式开关（Aa 大小写 / ab 全词——开启后 pnpm/batnpmdom
  不命中 npm / .* 正则 / fz 模糊子序列）、vscode 同款摘要窗口（lcut 词边界前导 +
  单行省略）、结果行多命中下拉（≤8 条，hover 显示层级线）；
- **自建高速索引**：仅索引 user/context/assistant 消息的文本块（排除工具
  参数/结果/推理等噪音），毫秒级响应，绕过官方引擎逐次 reconcile；
- **跳转高亮**：点击命中进入会话后自动定位，所选命中高亮填充
  （rgba(65,118,230,.16) 底 / #2b5bb8 字），其余同名词框选不高亮
  （1px rgba(65,118,230,.55) 边框），可一键清除。

> 移植基线：官方包版本 0.1.0-rc.6（`src/client/workspace-browser.js` 开头的
> 注释记录出处）；未修改区域与官方产物逐字节一致，所有改动均以
> `// [search-plus]` 标记。官方升级后需按新基线重做移植。

## 架构

- **宿主半**（`src/index.ts`）：维护私有内存内容索引——启动时从持久化服务
  全量构建，随后通过 `session/event` 订阅增量更新（按 (sessionId, seq) 去重）；
  提供 `POST /api/search-plus/query`（子串或 fzf 式模糊子序列、大小写开关、
  按会话分组的窗口化摘要与命中偏移）。
- **浏览器半**（`src/client/`）：即上述 WorkspaceBrowser 移植；内容查询走
  `/api/search-plus/query`，标题过滤留在客户端。

## 相关插件

官方索引的启动预热在兄弟插件 **dsh-session-search-warmup** 中：它在进程
启动的安静窗口内提交官方 SQLite FTS5 索引，让本插件不接管的官方搜索表面
（窄栏模式、回退路径）第一次查询即可用。两者互补，建议同时安装。

## 安装

在 profile 目录执行：

```sh
dsh plugin --profile web add dsh-session-search-plus
# 或手动：在 package.json 的 dependencies 与 dsh.profile.bundles 中加入本包
# （file: 路径），然后 pnpm install
```

**注意**：不要同时把 `session-search-plus` 这一 insert 行写进 profile 自己的
`cordis.patch.yml`——loader 会因重复 insert id 拒绝启动（与 dsh-ui-attention
等插件同款规则）。

profile 还需停用官方 `ui-workspace` 行（本移植接管其槽位），见
`~/.dsh/profiles/web/cordis.patch.yml`。

## 验证

```sh
dsh --profile web --dump-config   # 应出现 session-search-plus 行
```

启动后观察宿主日志：

```
[search-plus] content index built: N docs from M sessions in Xms
```

随后在侧栏搜索框输入：出现带着色摘要与多命中下拉的内容结果即接管成功。

## 开发

```sh
pnpm install
pnpm run bundle   # 构建 lib/
pnpm test
```
