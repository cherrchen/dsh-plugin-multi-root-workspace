# Files 页被第三方整页接管时的官方 Toast 提示（Issue #47）

> 状态：**已实施并通过本机门禁，Draft PR 待评审与 CI（2026-11-15，分支 `feat/file-slot-error`）**。本文件是 Issue #47 限定范围的实施计划、进入/退出验收机制与证据账本；验收结果见 §12，PR 合并后随计划归档。
>
> 关联：Issue [#47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)、[ADR-0015](../../decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[故障排查：Files 页签选择器退化](../../troubleshooting/files-switcher-degraded.md)、[Files 页签根浏览计划](../completed/2026-10-12-files-header-root-browsing.md)。

## 1. 背景与目标

Issue #47 记录：第三方插件（如 dsh-better-sidebar）以 `priority: "extension"` 注册 `kind: "files"` 后，宿主内置「工作区文件」页被遮蔽、不再渲染；本插件的根切换器注册在 `sidebar.right.tab.files.actions` 上，该 actions 区由宿主 `FilesBody` 声明并渲染，于是切换器**完全不出现且没有任何提示**——用户只会以为插件没装好。

本轮按维护者决定只做三件事：

1. 只覆盖 Issue #47 的「Files 页被接管」这一种失效；
2. 提示形态用**官方瞬时 Toast**（几秒后自行消失）；
3. 不叠加 Issue 建议的方案 1（不在 🗂 对话框与 `/workspace-folders` 输出里加文案），且提示等级比 warning 再低一级：**info 级**，不带警告图标。

目标：接管发生时，在页面顶部弹出一条官方 `Toast`（纯文本、无警告字形），说明 Files 页由其他插件接管、根切换器暂不可用；提示只弹一次、几秒后消失，接管解除后若再次发生可再次提示。非目标见 §3。

## 2. 事实核验（开工依据）

实施前已完成上游源码核对（`deepseek-harness` 仓库，标签 `dsh-v0.2.0-rc.2`、`dsh-v0.2.2-rc.1`、`dsh-v0.2.2-rc.3`），以下四条构成本计划的依据：

### 2.1 不能用 `slots.inject` / `slots.spec` 判断「inject 失败」

- `sidebar.right.tab.files.actions` 由 `ui-sidebar-files` 注册 `FilesBody` 时通过 `children` 声明（`packages/client/ui-sidebar-files/src/client/index.ts` 的 `ctx.slots.inject('sidebar.right.pane.tab', …)` 注册块，`children: { 'sidebar.right.tab.files.actions': … }`）。
- `children` 在 `register` 时立即写入槽声明；`sidebar.right.pane.tab` 又由右侧栏壳在启动时声明。因此**被接管时该槽仍处于 declared 状态**，本插件的 `slots.inject` 大概率照常触发（只是 occupant 不被渲染），`spec()` 也返回非空。
- 结论：Issue #47 里「该槽从未被声明、inject 不会触发」的机制推断不可作为检测依据；检测必须指向 tab 注册表的**生效实现**。

### 2.2 可靠的检测源：`sidebarRightTabs`

- 客户端服务 `ctx.sidebarRightTabs` 由 `ui-sidebar-right` 通过 `ctx.reflect.provide` 提供；`0.1.5-rc.2` 起即存在。
- `get(kind)` 返回该 kind 的**生效定义**（`in-force definition`），`subscribe(listener)` 在注册/移除时通知；两者在 `0.2.0-rc.2` 均已存在。
- 内置 Files 定义：`id = '@deepseek-ai/dsh-client-ui-sidebar-files'`、`priority = 'builtin'`；`extension` 注册（如 better-sidebar）接管后 `get('files')` 返回 extension 定义。
- Files 页与 `files.actions` 槽自 `0.2.0-rc.2` 才存在；更早版本 `get('files')` 为 `undefined`，必须静默（不提示）。

### 2.3 官方 Toast 的「info 级」形态

- 官方 `Toast` 在支持矩阵内只提供 `tone?: 'success'`；`icon` 缺省时**不渲染任何字形**（有 icon 时落在 warning 色座席），因此比 warning 更低一级的 info 呈现就是：**纯文本 + 不传 icon、不传 tone**。
- `shell.overlay` 槽自 `0.2.0-rc.2` 存在（上游 chat 欠费提示即在用），与本提示的版本面完全重合。
- `Toast` 的 `text` / `onDone` 自 `0.1.5-rc.2` 就有，`holdMs` 亦可用；本提示不依赖 `tone` / `actions`。

### 2.4 现有同类先例

- `src/client/open-in-app/open-toast.tsx` 是「插件以 `shell.overlay` 注册官方 Toast」的既有范式（store → inject hooks → 组件渲染 `Toast`）；本计划复用同一形态，只把呈现降到 info 级（不传 icon）。
- 设置卡（Auto Review / Skills）也用官方 `Toast`，但那是操作失败反馈且带 warning 图标，不是本轮目标。

## 3. 范围与非目标

**范围内**

- 新增客户端探测：`ctx.get('sidebarRightTabs')`（经 `ctx.inject(['sidebarRightTabs'], …)` 等待服务）→ `get('files')` → 按 `priority`/`id` 判定 `builtin` / `shadowed` / `absent`。
- 新增 `shell.overlay` 官方 Toast 条目：接管时弹一次 info 级纯文本提示，数秒后自动消失。
- 提示去重与重整：同一接管只提示一次；接管解除后重置；不同 extension 再次接管可再次提示。
- 词典（中英）、组件/接线测试、compat 探测单测、构建与文档更新。

**非目标（本轮不做）**

- 不做 Issue 方案 1：不改 🗂 对话框、不改 `/workspace-folders` 输出、不新增命令文本文案。
- 不做 Issue 方案 2/3：不把切换器改渲染到 footer/面板、不注册自有 tab kind。
- 不改视觉接管行为、不改 `RootSwitcher`/`FilesBody` 的渲染与样式、不改任何 `data-*` 钩子依赖。
- 不改 host 半部、不改 RPC/契约/权限/Registry、不引入新运行时依赖、不改支持矩阵与 `dsh.client.inject`。
- 不处理「宿主根本没有 Files 页」的旧版本（静默是正确行为）。

## 4. 设计

### 4.1 兼容探测：`src/compat/files-page.ts`

结构性探测（不做版本字符串比较），导出：

- `FILES_TAB_KIND = 'files'`；`BUILTIN_FILES_TAB_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'`。
- `FilesPageState = { kind: 'absent' } | { kind: 'builtin'; id?: string } | { kind: 'shadowed'; id?: string }`。
- `filesPageState(tabs: unknown): FilesPageState`：
  - 服务/`get` 不是函数 → `absent`；
  - `get('files')` 非对象或 `undefined` → `absent`；
  - `priority === 'builtin'` **或** `id === BUILTIN_FILES_TAB_ID` → `builtin`；
  - 其余 → `shadowed`（`priority` 缺省即 extension 的默认语义，无需特判）。
- `subscribeFilesPage(tabs: unknown, listener: () => void): () => void`：`subscribe` 是函数则订阅并返回退订；否则返回空 disposer（结构探针，绝不抛错）。

只读取 `id`/`priority`/`get`/`subscribe` 四个成员，不 import `dsh-client-ui-sidebar-right`（该包不是本插件的 devDependency，也绝不进入 client bundle 的 module table）。

### 4.2 客户端接线：`src/client/files-page-notice.tsx`

- `createFilesPageNoticeSource()`：与 `open-toast` 同型的 snapshot store，状态为 `{ seq: number } | null`；`report()` 递增 `seq` 并发布（同一提示重弹靠 key 重启动画），`dismiss()` 置空。
- `FilesPageNoticeToast`：`shell.overlay` occupant；渲染官方 `Toast`，`text = t('filesPage.notice')`，**不传 `icon`/`tone`**（info 级），`holdMs = FILES_PAGE_NOTICE_HOLD_MS`（5000ms），`onDone = dismiss`。
- `installFilesPageNotice(ctx, source, t)`：
  1. 在根上下文注册 `shell.overlay` 条目（软 `slots.inject`，槽不存在则不注册）；
  2. `ctx.inject(['sidebarRightTabs'], scope => …)` 等待服务，服务永不出现时整段不执行（旧宿主静默）；
  3. 在子 fiber 内 `scope.effect(...)`：订阅注册表、先求值一次；求值状态变化时提示或重置；
  4. 去重：记录已提示的接管实现 id（缺省用 `'unknown'`）；同一 id 的后续通知不再提示；状态回到 `builtin`/`absent` 时清除记录。
- `src/client/index.ts` 的 `apply` 末尾接线：创建 source 并调用 installer；词典已在同一 `apply` 注册。

### 4.3 文案（中英）

- `filesPage.notice`（中文，canonical）：`检测到第三方插件接管了 Files 页，工作区目录根切换器暂不可用；仍可从侧栏「工作区目录」管理。`
- 英文：`Another extension has taken over the Files page, so the workspace folder switcher is unavailable; manage roots from Workspace Folders in the sidebar instead.`
- 走 `src/client/locales.ts` 词典 + `t`，由 `tests/locale-parity.spec.ts` 保证双语一致；不硬编码。

### 4.4 兼容与降级矩阵

| 情形 | 行为 |
| --- | --- |
| 宿主无 `sidebarRightTabs`（极旧/裁剪组合） | `ctx.inject` 永不触发，不提示、不报错 |
| 宿主有服务但无 `files` kind（`0.1.x`、`0.2.0-rc.1`） | `absent`，不提示 |
| 内置 Files 页生效（`priority: 'builtin'` 或内置 id） | 不提示；若此前提示过则重置去重状态 |
| 第三方 extension 接管 Files kind | 弹一次 info 级官方 Toast |
| 接管持续期间注册表多次通知 | 同一实现 id 不再弹 |
| extension 移除、内置恢复后再次接管 | 重新弹一次 |
| 注册表无 `subscribe`（未被任何支持版本使用） | 仅启动时求值一次，不抛错 |
| `shell.overlay` 槽不存在 | 不注册 Toast 条目；探测仍不报错 |

### 4.5 不变量

1. **提示不是授权/状态源**：它只读注册表，不改任何插件状态、不写存储、不调 host。
2. **只提示一次**：同一接管实现 id 只弹一次；恢复后重置。
3. **默认静默**：任何探测失败（服务/方法/定义缺失）都按「无接管」处理，绝不误报。
4. **不新增运行时依赖**：只用已有 external（`dsh-client-store`、`dsh-client-ui-primitives`）与 `shell.overlay`。

## 5. 测试计划（红 → 绿）

| 编号 | 测试 | 文件 | 断言 |
| --- | --- | --- | --- |
| T1 | 探测三态与 id 回退 | `tests/compat-files-page.spec.ts`（新增） | 无服务/无 get/无定义 → `absent`；builtin priority 与 builtin id 各自 → `builtin`；extension priority/缺省 priority → `shadowed`；`subscribe` 缺失返回空 disposer |
| T2 | 接线：接管弹一次 | `tests/client-files-page-notice.spec.tsx`（新增，jsdom） | 初始 builtin 不弹；通知切到 extension → 弹 1 次；继续通知 → 仍为 1 次，`seq` 不变 |
| T3 | 接线：恢复后重整 | 同上 | 切回 builtin → 状态清空；再次 extension 接管 → 再弹（`seq` 递增） |
| T4 | 接线：默认静默 | 同上 | 服务缺失、`get` 缺失、无定义、`subscribe` 缺失均不弹；`shell.overlay` 缺席时不注册且不抛错 |
| T5 | 组件：info 级官方 Toast | 同上 | 渲染后出现 `role=status` 文本（来自词典），**不出现警告图标**（stub 以 `data-icon="warning"` 标记，断言不存在）；`onDone`（点击 stub）后消失 |
| T6 | 集成不回归 | `tests/client-slot-probe.spec.ts`、`tests/client-bundle.spec.ts`、`tests/locale-parity.spec.ts` | 既有 `apply` 探针不因新接线抛错；bundle 的 `require(...)` 列表不变、包含新文案；词典键齐 |

红测要求：T2–T5 在实现前先写，能失败于「没有提示/重复提示/误报/警告图标存在」。

## 6. 分阶段提交

| 阶段 | 提交 | 内容 | 门禁 |
| --- | --- | --- | --- |
| P0 | `docs(plan): record the Files-page takeover notice plan` | 本文件 + 计划索引（中英） | `pnpm docs:check` |
| P1 | `feat(compat): probe the effective Files tab implementation` | `src/compat/files-page.ts` + T1 | 对应 vitest、lint、typecheck |
| P2 | `feat(client): show an info Toast when a Files page takes over` | source/组件/installer、`index.ts` 接线、词典、T2–T5 | 对应 vitest 红→绿、lint、typecheck、build |
| P3 | `docs: record the takeover notice in ADR, troubleshooting and README` | ADR-0015 修订、troubleshooting 一节、README/README.en、compat 笔记 | `pnpm docs:check` |
| P4 | `chore(verify): record gates and open the draft PR` | 本文件 §11 证据回填 | 全量门禁 + PR |

## 7. 进入验收机制（开工前必须全部成立）

| 门 | 条件 | 本轮证据 |
| --- | --- | --- |
| E0-1 | 从 `main` 干净切出工作分支，工作区无未提交改动 | `git status` 干净、`git switch -c feat/file-slot-error`（2026-11-15） |
| E0-2 | 范围锁定维护者三条决定：只做 #47 接管场景；瞬时官方 Toast；不叠加方案 1、info 级无警告图标 | 本文件 §1/§3 |
| E0-3 | 检测源与判据已用上游源码核实，不依赖 `slots.inject`/`spec` | §2.1/§2.2（`dsh-v0.2.0-rc.2`、`dsh-v0.2.2-rc.1`、`dsh-v0.2.2-rc.3`） |
| E0-4 | 呈现面已核实：官方 `Toast` 的 info 形态（无 icon/tone）与 `shell.overlay` 版本面重合 | §2.3 |
| E0-5 | 计划与索引已提交且 `pnpm docs:check` 通过 | P0 提交 `49eceb0` |

任一条不成立 → 停止并回报，不开始 P1。

## 8. 退出验收机制（完成本任务必须全部满足）

| 门 | 内容 | 证据 |
| --- | --- | --- |
| E1 | T1 通过：三态判定、id/priority 双判据、订阅缺失降级 | vitest 输出 |
| E2 | T2/T3 通过：接管弹一次、持续接管不重弹、恢复后重整可再弹 | vitest 输出 |
| E3 | T4 通过：所有探测失败路径默认静默；`shell.overlay` 缺席不抛错 | vitest 输出 |
| E4 | T5 通过：渲染信息为词典文案、无 warning 图标、`onDone` 后消失 | vitest 输出 |
| E5 | T6 通过：`client-slot-probe`、`client-bundle`、`locale-parity` 无回归；bundle `require` 列表不变 | vitest 输出 |
| E6 | 本机门禁：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check` | 命令输出 |
| E7 | 全量 `pnpm test`：本机环境限制导致的既有失败须与基线 `main` 对照并逐项说明，不得引入新失败 | vitest 汇总 + 基线对照 |
| E8 | 文档：ADR-0015 修订（决策、检测源、非目标）、troubleshooting 新症状节、README 中英同步、计划索引（中英）、本文件 §11 回填 | `docs:check` + diff |
| E9 | 分支推送并以 **Draft PR** 提交；PR 描述含概要、验证命令与证据、限制，末尾 `Close #47`；记录 CI run URL（CI 结束前 PR 保持 Draft） | `gh pr view` / `gh run view` |
| E10 | 明确记录「GUI 目检」状态：本机无法安装 better-sidebar 时，以组件/接线测试为自动化证据，GUI 目检交由评审者按 Issue #47 复现步骤完成，并在 PR 描述中标注 | PR 描述 |

**停止/回退条件（出现即暂停并报告，不硬推）**

- 探测在「内置 Files 页生效」时误报：立即停止，收紧判据（优先 `priority === 'builtin'`，id 仅作兜底）并补误报回归。
- 注册表订阅抖动导致同一接管重复弹提示：停止，改为按生效实现 id 去重并补 T2 断言；仍抖动则退化为只做启动时一次求值。
- `Toast`/`shell.overlay` 在任一支持版本上导致客户端图加载失败（缺失导出/类型）：停止，改为 luxe 探测后不注册（保持默认静默），并记录到 compat 笔记。
- 出现与范围外行为（视觉接管、host/RPC、权限）相关的改动需求：拆出独立 Issue/计划，不在本分支扩张。
- 全量测试出现与本改动无关的失败：用 `main` 基线复跑同一批用例对照，只允许既有环境限制与基线一致。

## 9. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 第三方 extension 只是临时注册、随即恢复 | 去重 + 恢复重置；提示是瞬时的，不持久化 |
| 未来上游改内置实现 id 或 priority 语义 | 双判据（`priority` 优先、id 兜底）；结构不匹配时按「无法判定」静默，不做版本字符串比较 |
| 主机组合里没有 `sidebarRightTabs` | `ctx.inject` 等待服务，永不触发也不报错 |
| 提示与其它官方 Toast 同时出现 | 官方 Toast 自身有堆叠渲染（portal 顶部），本提示只弹一次、5s 消失，风险可接受 |
| 需要回滚 | 整个改动是新增客户端模块 + `apply` 一行接线 + 词典；回滚即删除文件与接线，无数据/契约迁移 |

## 10. Documentation Impact

- `docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md`：新增修订节「整页接管时的可见提示」——问题（静默退化路径根本走不到）、决策（只读 tab 注册表的生效实现；官方 Toast info 级；一次/恢复重整）、非目标（不改对话框/命令/接管行为）。
- `docs/troubleshooting/files-switcher-degraded.md`：新增「Files 页被第三方整页接管」症状、根因（seat 未渲染，槽位声明 ≠ 渲染）、诊断（`sidebarRightTabs.get('files')`）与提示行为。
- `docs/plans/README.md` / `docs/plans/README.en.md`：active 索引登记本计划。
- `README.md` / `README.en.md`：Files 页签说明补一句「被第三方整页接管时弹一次瞬时提示；根仍可从侧栏管理」；已知限制同步。
- `.agent/note/dsh-compat-contract.md` / `.en.md`：记录 `sidebarRightTabs` 服务、`get`/`subscribe` 与内置 Files id/priority 的结构事实（双语）。
- `CHANGELOG.md` / `CHANGELOG.en.md`：按发版流程由版本准备提交统写入，本功能分支不直接改（避免与发版提交冲突）。

## 11. 进度与证据（执行后回填）

| 阶段 | 状态 | 提交 | 证据 |
| --- | --- | --- | --- |
| P0 | 已完成 | `49eceb0` | 本文件 + `docs/plans/README.md` / `README.en.md` 索引；`pnpm docs:check` 0 errors |
| P1 | 已完成 | `c4d5f13` | `src/compat/files-page.ts` + `tests/compat-files-page.spec.ts`（11 tests）；`pnpm lint`、`pnpm typecheck` 通过 |
| P2 | 已完成 | `103c10e` | `src/client/files-page-notice.tsx`、`src/client/index.ts` 接线、`src/client/locales.ts` 词条、`tests/client-files-page-notice.spec.tsx`（12 tests）与 stub 的 `data-hold-ms`；focused 29 tests 通过；`pnpm build` 后 `client-bundle` / `client-slot-probe` / `client-panel` 共 95 tests 通过 |
| P3 | 已完成 | `3fc365e` | ADR-0015 修订、troubleshooting 新症状节、README 中英（功能说明 + 已知限制）、compat 笔记第 20 节（中英）；`pnpm docs:check` 0 errors |
| P4 | 已完成 | 本提交 | `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm docs:check` / `pnpm compat:check` / `pnpm pack:check`（230 members）全绿；全量 `pnpm test`：**1836 passed / 17 failed / 165 skipped（2018）**，`main` 基线为 1813 passed / 17 failed / 165 skipped（1995），失败集合逐项相同（均为本机沙箱下 Registry authority/lease IPC 用例，`diff` 为空）；新增 23 项测试全部通过；分支推送并创建 Draft PR |

## 12. 验收结果（2026-11-15）

| 门 | 结果 | 证据 |
| --- | --- | --- |
| E1 | 通过 | `tests/compat-files-page.spec.ts` 11 tests：三态、id/priority 双判据、`get` 抛错降级、订阅缺失 no-op |
| E2 | 通过 | `tests/client-files-page-notice.spec.tsx`：接管弹 1 次、持续通知不重弹、恢复后再次接管 `seq` 递增、启动时已接管补弹 |
| E3 | 通过 | 同上：无服务 / 无 Files kind / 无订阅 / `shell.overlay` 缺席均不弹且不抛错 |
| E4 | 通过 | 同上：`role=status` 文案来自词典、无 `svg`（警告图标）、`data-hold-ms=5000`、点击（stub 的 `onDone`）后消失 |
| E5 | 通过 | `client-bundle`（require 列表与 `dsh.client` 不变）、`client-slot-probe`、`client-panel`、`locale-parity`、`client-switcher` 全绿（focused 7 files / 142 tests） |
| E6 | 通过 | §11 P4 所列六条门禁（`pack:check` exit 0，230 members） |
| E7 | 通过 | 全量测试失败集合与 `main` 基线逐项相同（见 §11）；本机既有环境限制，改动未引入新失败 |
| E8 | 通过 | ADR-0015 修订、troubleshooting、README 中英、compat 笔记中英、两个计划索引；`docs:check` 0 errors |
| E9 | 通过（CI 待跑） | 分支 `feat/file-slot-error` 推送后创建 Draft PR，描述末尾 `Close #47`；CI run URL 记录在 PR 中 |
| E10 | 已记录 | 本机无法安装 better-sidebar（不改用户宿主组合），GUI 目检按 Issue #47 复现步骤交由评审者完成：装 better-sidebar → 顶部一次 info Toast、切换器不出现；停用 → 切换器恢复、再次接管再提示。自动化证据为 E1–E5 |
