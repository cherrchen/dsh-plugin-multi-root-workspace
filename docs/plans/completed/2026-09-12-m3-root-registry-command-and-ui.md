# M3 开发计划：Root 注册表、`/workspace-folders` 命令与 Workspace Folders UI

> 状态：completed（2026-09-12 实施完成并验证）| 日期：2026-09-12 | 里程碑：M3（共 M1/M2/M3）
> 目标运行时：dsh `0.1.5-rc.2`（pin）；同时兼容已安装桌面运行时 `0.1.2-rc.1`
> 里程碑划分：[2026-09-12-multi-root-workspace.md](../active/2026-09-12-multi-root-workspace.md)；设计：[multi-root-workspace.md](../../architecture/multi-root-workspace.md) §7；需求与验收：[multi-root-workspace.md](../../requirements/multi-root-workspace.md) §5/§7/§9/§15；上游事实：[multi-root-workspace-research.md](../../reference/multi-root-workspace-research.md)
> 决策依据：[ADR-0001](../../decisions/ADR-0001-provider-replacement-scope.md)、[ADR-0002](../../decisions/ADR-0002-upstream-coupling-policy.md)、[ADR-0003](../../decisions/ADR-0003-dialect-grant-widening.md)、[ADR-0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[ADR-0005](../../decisions/ADR-0005-out-of-tree-client-transport.md)

## 目标与成功标准

让**用户**（而不是测试脚本）成为附加根的来源：注册表持久化 + 校验 + 命令 + 浏览器面板，端到端可用，且不破坏 M1/M2 已建立的安全网。

可判定成功标准：

1. `pnpm lint` / `typecheck` / `test` / `build` / `smoke:compose` / `smoke:behavior` / `smoke:journey` / `docs:check` 全绿。
2. **空根零回归**：未注册任何附加根时，`smoke:compose` 只差「2 行 disabled + 5 行 insert」，`smoke:behavior` 的 plugin↔baseline 逐项比对仍完全一致。
3. **用户旅程可用**：通过 `/workspace-folders add`（无路径参数时走 `directoryPicker`）或面板 Add 注册的附加根，在下一次受限调用即被 fs fence 与内核方言同时授予；Remove/Alias/Reveal/排序可用。
4. **持久化与恢复**：注册表落在 `$DSH_HOME/storages/multi_root_workspace.json`；进程重启后根集不变；主根目录不存在的项在启动时**降级为跳过并让用户可见**（面板标记 + 命令输出 + 一次性 `logger.warn`），不静默、不阻断 harness 启动。
5. **失败要响亮**：非绝对路径、目录缺失、非目录、重复（canonical 后）、等于主根、嵌套，在 add 时返回明确错误码与文案；存储中不可解析的记录 → 备份并跳过 + 可见提示；domain 版本不符 → 装载抛错。
6. **单一权限世界不退化**：`smoke:behavior` 的多根电池 + parity 矩阵在注册表驱动路径上重跑通过（根集合来源换成注册表，判定集合与方言 argv 授予集合仍逐项一致）。
7. **UI 双语**：面板文案经 `ctx.locale.register` 注册，zh/en 键集完全一致（仓库内自建 parity 测试门禁）。
8. **双运行时**：`smoke:compose` / `smoke:behavior` / `smoke:journey` 在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 上均通过（新增行与 client 半部只在 0.1.2 缺失的 slot 上做退化，不做版本硬门槛）。
9. 上游仓库零改动；`AGENTS.md` 的「当前项目状态」如实更新。

## 背景与当前状态（实施前实测）

- M1/M2 已交付：两行 provider 替换 + `MultiRootScopeService`（数据源是进程内登记表）+ 拓扑快照 + 方言 grant + parity 矩阵；`setAdditionalRoots()` 目前只由测试与冒烟调用。
- 注册表所需的上游公共面已确认存在：`ctx.storageDomain`（domain KV，zod 表 schema，base bundle 在 web/headless 都挂载）、`ctx.commands.register`（base 行，两个 profile 都有）、`ctx.directoryPicker.capability()`、`ctx.slots.inject/register`、`ctx.locale.register`。
- `ctx.workspaceRegistry` 只在 web-app 组合中存在（headless 没有），因此注册表不能以 `WorkspaceId` 为键。
- 浏览器 ↔ host 的**出树通道**是本计划的关键约束，见下方修正表。

## 对路线图 M3 段落的修正（含证据）

| 路线图原文 | 本计划 | 依据（实测） |
| --- | --- | --- |
| 「picker 洞接入（`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`）」 | **不接入**这两个洞。add 改走：命令侧 `ctx.directoryPicker.capability().pick(signal)`，面板侧 `ctx.uiWorkspace.pickDirectory()` | 这两洞是 ui-workspace **创建工作区**流程的 single-kind 洞（owner 收到路径后调 `createWorkspace`），默认组合已被 `directory-picker-auto` 的 native/browse client 半部占满；再占会冲突且语义错误（`packages/client/ui-workspace/src/client/contract/slots.ts:41-59`、`ui-directory-picker-browse/src/client/index.ts:86-94`） |
| 「Typert 远程命名空间 `multiRootWorkspace`」 | **M3 不做**。面板改用公开的 Connection RPC 通道：host `ctx.connection.rpc.handle('/multi-root-workspace', …)`，client `connection.rpc.call(...)` | Typert 契约生成是 workspace 形状的（generator 需 `<root>/tsconfig.host.json` 且只接受 `<root>/packages` 下的引用，`packages/typert/generator/src/tsdown-plugin.ts:154-162`、`analyzer.ts:482-488`）；client 侧 `@deepseek-ai/dsh-api-remotes/client` 挂的是上游静态清单（`packages/api/remotes/src/client/index.ts:3-30`）。Connection 通道是已发布 out-of-tree 插件 `@dsh-electron/dsh-plugin-git@0.2.0` 在用的同一公开缝（其 `src/index.ts:72`、`src/client/controller.ts:12-19`），且 `rpc.handle`/`rpc.call` 在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 都存在 |
| 「client 半部：Folders 面板」 | 面板落在 `sidebar.footer.action`（list/root，两个运行时都存在、additive）+ 自绘对话框 | `0.1.5-rc.2` 的 `sidebar.panellist`/`main`(keyed) 在 **0.1.2-rc.1 中不存在**（0.1.2 的 sidebar contract 只有 brand/workspaces/settings/footer.action）；`sidebar.workspaces` 是 single 且已被 ui-workspace 占用，不能加减 |
| 「注册表 key = canonical 主根 / workspaceId」 | **定死 canonical 主根**（字符串键）。不用 `WorkspaceId` | provider 只能从 `policy.workspaceRoot` 解析（`src/scope.ts`）；`ctx.workspaceRegistry` 只在 web-app 组合中存在 |
| 「nested 暂允许并记录，M3 前拍板」 | **拍板：add 时拒绝嵌套**（双向：候选在某根之下，或候选包含某根），并给出点名冲突根的错误 | 联合语义下嵌套项不产生任何额外授予，却让「面板列出的 N 项」与「实际授予集合」不再一一对应；启动时对存储数据用同一规则重校验，违规项跳过并通知 |
| 「可选 `workspace_roots` 内省工具」 | **默认不做**；以 journey smoke 的拓扑证据作为判定闸门（见 T10） | 需求 §9 预留删除条件；M2 拓扑快照已列全部附加根且落 model history |
| 「e2e：web + headless 双 profile」 | 用**真实组合 + 无凭据脚本化模型**在进程内驱动真实 agent turn（两个 profile 各一轮），不引入 Playwright/浏览器车道 | 上游 web 车道依赖未发布的 `apps/web/tests/scaffold.ts`（fork 它违反 ADR-0002）；`@deepseek-ai/dsh-loader-smoke`（已发布、public）导出 `runFixtureTurn`；`DEEPSEEK_BASE_URL` 是官方脚本化模型缝（`packages/llm/llm-deepseek/src/index.ts:137,213`） |
| 「桌面端（apps/desktop）冒烟」 | 不在 M3 建 Electron 车道；改为「构件可移植性断言 + 人工验证步骤」写进开发流程 | 上游自身没有桌面 e2e 车道（44 个桌面 spec 全部 mock Electron）；已安装 app 是第三方 shell（0.1.2-rc.1），其 profile 就是 `web` |

## 范围（三阶段，每阶段独立可验证）

- **阶段 A（host，先做）**：注册表 + 校验 + 启动降级 + `/workspace-folders` 命令 + 组合面/冒烟更新。
- **阶段 B（面板）**：client 半部（footer action + 对话框 + 双语）+ 双面构建 + 面板 RPC 通道 + client 测试。
- **阶段 C（旅程与工程化）**：journey smoke（双 profile、双 git repo、脚本化模型）+ 升级 smoke CI + README + 文档收口。

## 非目标

- Windows pwsh/ACL 内核级多根；read-only root / per-root 权限；`*.dsh-workspace.json`；`workspace-files` 多根 confine。
- 自有 session 事件；`workspaceRegistry` 集成（面板不新建/改名工作区）。
- `sidebar.panellist`/`main` 全屏面板（0.1.5 专属）、Playwright 浏览器车道、Electron 车道。
- 以附加根作为 bash/PTY 默认 cwd（`policy.workspaceRoot` 语义不变）。

## 设计

### D1 注册表数据模型与存储（`src/registry.ts`）

```ts
export type AdditionalRootId = string & { readonly __multiRootAdditionalRootId: 'AdditionalRootId' }
export interface RegisteredRoot { id: AdditionalRootId; path: string; alias?: string; addedAt: string }
export interface RootStatus extends RegisteredRoot { state: 'available' | 'missing' }

export class MultiRootRootRegistry extends Service {   // ctx.multiRootRoots
  static inject = ['storageDomain', 'multiRootScope']
  list(primaryRoot: string): readonly RootStatus[]
  add(primaryRoot: string, input: { path: string; alias?: string }): Promise<readonly RootStatus[]>
  remove(primaryRoot: string, ref: RootRef): Promise<readonly RootStatus[]>
  setAlias(primaryRoot: string, ref: RootRef, alias: string | undefined): Promise<readonly RootStatus[]>
  move(primaryRoot: string, ref: RootRef, beforeRef?: RootRef): Promise<readonly RootStatus[]>
  recheck(primaryRoot: string): Promise<readonly RootStatus[]>
  onChange(listener: (primaryRoot: string) => void): () => void
}
export type RootRef = { kind: 'id'; id: AdditionalRootId } | { kind: 'path'; path: string } | { kind: 'ordinal'; ordinal: number }
```

- 存储：`defineDomain({ name: 'multi_root_workspace', version: 1, invalidRecords: 'backup-and-skip', tables: { roots: domainTable<PrimaryRootKey, RootRecord>(rootRecordSchema) } })`，默认 `single` layout → `$DSH_HOME/storages/multi_root_workspace.json`；**键 = canonical 主根**（`single` layout 下键是任意字符串，路径安全；将来若改 `per-record` 必须同时改键方案——写进 ADR-0004）。
- `rootRecordSchema = z.object({ roots: z.array(z.object({ id: z.string(), path: z.string(), alias: z.string().optional(), addedAt: z.string() })) })`；`zod` 进 `dependencies`（`^4.4.3`，与上游 `dsh-storage-domain` 同源）。
- `[Service.init]`：`open` domain → 逐键读取 → 用 D2 规则重校验（canonical 化、去重、剔除等于主根/嵌套/非法、存在性 `recheck`）→ **只把 available 根播种进 `ctx.multiRootScope.setAdditionalRoots()`**（missing 不授予，避免 bwrap/Landlock 运行期失败，闭环 M2 风险 #6）→ 计算 missing 集合并 `logger.warn` 一次。
- 每次变更：先 durable 写（`table.put`），成功后重播种 scope 并 `onChange` 通知；写失败即抛出、scope 不变（内存与磁盘不漂移）。
- 注入缺失（如 sdk-minimal 无 storageDomain）时该行不激活 → 附加根为空 → 行为回落到 M1/M2 直通路径。
- `setAdditionalRoots` 仍是 scope 的公开写口，由注册表调用；测试/冒烟继续可用。

### D2 校验纯函数（`src/roots.ts`）

```ts
export type RootValidationCode = 'not-absolute' | 'missing' | 'not-a-directory' | 'duplicate' | 'equals-primary' | 'nested' | 'not-found' | 'invalid-ref'
export class RootValidationError extends Error { readonly code: RootValidationCode }
export function expandRootInput(raw: string, homedir?: string): string        // 仅展开前导 `~`，其余相对路径保持原样以便判 not-absolute
export function canonicalRoot(path: string): string                          // canonicalPath（realpath）封装
export function validateCandidate(input: { primaryRoot: string; existing: readonly string[]; raw: string }): string
```

规则顺序（每一步失败即抛，错误码唯一）：非绝对 → 不存在/非目录 → canonical → 等于主根 → 与已有根重复 → 嵌套（候选在某根之下，或某根是候选的子目录，点名冲突根）。全分支 100% 覆盖。

### D3 启动降级与用户可见通知

三类可见面（不新增事件类型、不改 session 格式）：

1. 面板把 missing/被丢弃项标为不可用并给出原因与路径；
2. `/workspace-folders list` 输出 `missing` 行与「已备份损坏记录」计数；
3. 每个启动周期一次 `ctx.logger.warn`（含 domain 名、备份路径）。

domain 版本不符 → `open` 拒绝 → 行激活失败（fail loud），文档写明恢复方式。

### D4 `/workspace-folders` 命令（`src/command.ts`）

- `ctx.commands.register({ name: 'workspace-folders', description, input: { hint }, handler })`；`rawInput` 自行分词（上游无 argv 设施）。
- 语法：`list`（默认）/ `add [path]` / `remove <n|path>` / `alias <n|path> [name]`（无 name 即清除）/ `reveal <n|path>` / `help`。
- `add` 无 path 时：软注入 `directoryPicker` → `capability().kind === 'native'` 则 `pick(signal)`；`browse` 或 seam 缺失则返回错误文案（提示改用面板或传路径）。
- 返回 `{ kind: 'success', text }` / `{ kind: 'error', text }`（上游命令结果只有这两种）；命令文案**英文**（host 侧无活动语言信息），面板文案双语——记为已知限制。
- `reveal`：软注入 `subprocess`，按平台执行 `open -R` / `explorer /select,` / `xdg-open`；失败返回错误文案（UI 动作，不 fail loud）。
- 该行同时挂载面板通道（D6），因为二者共用「用户表面」；模块头注明这一耦合。命令/通道均以 `ctx.inject([...])` 软挂载，缺 `commands`/`connection` 时该部分静默不挂，provider 不受影响。

### D5 浏览器面板（`src/client/*`）

- 注册：主 fiber `inject = ['slots', 'connection', 'locale']`；`ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'multi-root-folders', order: 50, label: () => t('action.label'), locale: NS }, WorkspaceFoldersAction))`（slot 不存在时 `inject` 不触发 → 0.1.2/未来运行时安全退化）。
- 触发器渲染「Folders」按钮；点击由组件自己渲染对话框（`role="dialog"`、内联样式、仅 React，不引 ui-primitives/不新增 CSS 管线）。列表项：主根（标记 `primary`、只读）/ 附加根（alias 或 basename、完整路径、`missing` 徽标）；行内动作 Remove / Alias（行内输入）/ Copy Path（`navigator.clipboard`，失败回退为选中文本）/ Reveal / 上移下移（对应 `move`）。
- Add：`ctx.get('uiWorkspace')?.pickDirectory()`；不可用时降级为路径输入框（headless/无工作区 UI 组合下仍可用）。
- 变更后重新 `list` 刷新；session 变化（当前会话 cwd 改变）时重取。
- 词典：`src/client/locales.ts` 的 `zh`/`en` 扁平常量 + `type Key = keyof typeof zh` + `satisfies Record<Key, string>`；`ctx.effect(() => ctx.locale.register(NS, { zh, en }), '…')`；`NS = 'multiRootWorkspace'`。

### D6 面板 ↔ host 的 RPC 契约（channel `/multi-root-workspace`）

- host：`ctx.inject(['connection'], c => c.connection.rpc.handle('/multi-root-workspace', async (endpoint, payload, signal) => …))`，返回 `{ ok: true, value } | { ok: false, error: { code, message, details } }`。
- 端点：`list` / `add` / `remove` / `alias` / `move` / `reveal`；请求体携带可选 `sessionId`。
- **主根解析**：`sessionId` → 该 session 的 `header.cwd` canonical；缺省/未知 → `ctx.sandboxPolicy.resolve().workspaceRoot` canonical。面板顶部显示当前作用的根，避免歧义。
- client：`connection.rpc.call('/multi-root-workspace', endpoint, payload)`（类型来自 `@deepseek-ai/dsh-client-connection/client` 的 type-only 导入 + 本地 `contract.ts`）。
- 错误码沿用 D2 的 `RootValidationCode` + `not-found` / `storage-unavailable`；文案由客户端按 code 本地化（错误码是稳定契约，message 仅作兜底）。

### D7 构建面与包清单

- `tsdown.config.ts` 改为双配置导出：node 面（现有入口 + `./registry`、`./command`，ESM、`neverBundle` = 依赖/peer）与 **client 面**（entry `src/client/index.ts`、`format: 'cjs'`、`platform: 'browser'`、`entryFileNames: 'client.js'`、`banner/footer/intro` = `window.__ModuleLoader__.load({ id, factory: (require) => {` … `return module.exports; } });`、显式 externals 白名单）。不引入上游未发布的 `clientBundle` preset（它 glob `packages/*/*/package.json`，出树不可用）。
- 新增 `tsconfig.client.json`（`jsx: react-jsx`、DOM lib、`rootDir: src`、`outDir: lib/types`，与 host 面分离），`build` = 两面 tsc + tsdown。
- `package.json`：`exports` 增 `./registry`、`./command`、`./client`；`files` 增 `lib/client.js`、`lib/types/client/**/*.d.ts`；`dsh.client = { platform: 'web', inject: [...], immediately: false }`；`dependencies` += `zod`；`peerDependencies` += `@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-client-connection`、`react`；`devDependencies` += 精确 pin 的新包；`pnpm-workspace.yaml#minimumReleaseAgeExclude` 追加对应条目。
- client externals 白名单 = 两运行时 `PLATFORM_MODULES` 交集（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`）；其余一律 inline。

### D8 `cordis.patch.yml`

在现有 `insert` 末尾追加两行（disable 仍在前）：

```yaml
- id: multi-root-registry
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/registry'
- id: multi-root-command
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
```

→ `smoke:compose` 的 `INSERTED` 与 `tests/patch.spec.ts` 期望同步改为 5 行；组合差分仍只允许「2 行 disabled + 5 行 insert」。

## 实施

| # | 任务 | 内容 | 验收点 |
| --- | --- | --- | --- |
| T0 | 探查（结论写入调研 §11） | ① `0.1.2-rc.1` 上 `defineDomain/domainTable/open/table` 行为；② `ctx.commands.register/execute` 在 0.1.2 的形态；③ `sidebar.footer.action` 两运行时的 register options；④ `ctx.sessions` 取 `header.cwd` 的公开路径；⑤ 新 devDep 可安装性；⑥ headless 无 `directoryPicker`/`connection` 时的分支行为；⑦ 本机脚本化模型可驱动 | 每条有结论 + 文件:行；不可用项给回退方案 |
| T1 | `src/roots.ts` + `tests/roots.spec.ts` | D2 纯函数与错误词汇 | 全分支覆盖；`~`/`..`/symlink 判重 |
| T2 | `src/registry.ts` + `tests/registry.spec.ts` | D1；测试用真实 storage 栈（按上游 `workspace.spec.ts` 的组装方式） | add/remove/alias/move 持久化往返；重挂载后根集不变；missing 跳过且**不**授予；nest/dup/eq-primary 拒绝；损坏记录备份跳过；每次变更后 `multiRootScope.resolve()` 同步 |
| T3 | `src/command.ts`（命令部分）+ `tests/command.spec.ts` | D4；进程内 boot 后 `ctx.commands.execute(agent, '/workspace-folders …', [], signal)` | 六个子命令的成功/错误路径；无 picker 时的提示 |
| T4 | 面板通道 + 单测 | D6；用假 connection 记录 `handle` 注册与端点行为 | 端点契约、`sessionId` 解析、错误码映射、无 `connection` 时不挂载且不报错 |
| T5 | 组合面与 host 冒烟 | D8；更新 `tests/patch.spec.ts`、`scripts/smoke-compose.mjs`；`scripts/smoke-behavior.mjs` 增「注册表电池」 | `smoke:compose` 全绿（新计数）；behavior 空根比对不回归 |
| T6 | client 源（`src/client/*`） | D5 | `inject`/注册选项/降级分支齐备 |
| T7 | 构建面 | D7 | `pnpm build` 产出 `lib/client.js` + 两面 d.ts；`pnpm pack` 含 client 制品 |
| T8 | client 测试 | 制品 spec + jsdom 挂载 spec + `tests/locale-parity.spec.ts` | 3 个 spec 全绿；zh/en 键集相等 |
| T9 | `scripts/smoke-journey.mjs` | 两个真实 git repo + 内联 OpenAI 兼容 SSE 脚本模型（`DEEPSEEK_BASE_URL`）+ `runFixtureTurn` 驱动真实 agent；web 与 headless 两个 profile 各一轮；断言世界状态 | 两 profile 全绿 |
| T10 | 拓扑 vs 工具判定闸门 | T9 中断言快照含全部附加根；若 agent 仍无法在附加根上行动，则实现 `workspace_roots` 只读工具并纳入 M3 | 结论写入「实施结果」与需求 §9 |
| T11 | 升级 smoke CI + README | `workflow_dispatch` 升级工作流 + README（中英） | 工作流可手动触发；README 双语一致 |
| T12 | 文档 | ADR-0004、ADR-0005；架构 §7、需求 §7/§9、开发流程、路线图、索引、`AGENTS.md` | `docs:check` 0 error |
| T13 | 全量验证 + 收口 | 双运行时矩阵、计划归档并写「实施结果」 | 见「验证」与「完成判据」 |

## 验证

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:/opt/homebrew/bin:$PATH"
pnpm lint && pnpm typecheck && pnpm test
pnpm build
pnpm smoke:compose      # 期望：只差 2 行 disabled + 5 行 insert
pnpm smoke:behavior     # 期望：空根比对不回归 + 注册表/多根电池全绿（不可执行项显式 skip）
pnpm smoke:journey      # 期望：web 与 headless 两 profile 的跨 repo 旅程全绿
pnpm docs:check
DSH_CLI=<另一运行时的 dsh 入口> pnpm smoke && DSH_CLI=… pnpm smoke:journey   # 双运行时
```

CI：`.github/workflows/ci.yml` 增 `pnpm smoke:journey`；新增 `upgrade.yml`（workflow_dispatch）。CI 不把 skip 记成通过。

## 风险与处置

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| 1 | 0.1.2-rc.1 的 storage-domain/commands API 与 pin 版不一致 | 双运行时退化 | T0 先实测；不一致则注册表行软挂载并在文档写「0.1.2 上仅 provider 生效」 |
| 2 | domain 写入无 schema 校验（上游只在 open 时校验） | 损坏数据 | 写前做 D2 校验；读取侧 `invalidRecords: 'backup-and-skip'` + 可见通知 |
| 3 | `single` layout 单文件改写 | 并发写 | domain 层按域串行化写入链；每次变更整文件原子写 |
| 4 | 面板 slot 在运行时缺失/被替换 | UI 不可见 | `slots.inject` 软注册；不硬失败；troubleshooting 记录判定方法 |
| 5 | 脚本化模型 journey 不稳定 | 假绿/假红 | 断言世界状态，不断言助手散文；mock 在测试进程内、端口 0 |
| 6 | 新 devDep 装不上 | 阻塞阶段 B/C | T0 先验；装不上则 jsdom 车道退化为「制品形态断言 + 假 ctx 单测」，journey 退化为「真实 CLI headless 子进程 + 内联 SSE」并记偏差 |
| 7 | 命令文案英文 | 中文用户体验 | 记为限制；面板全双语 |
| 8 | 面板 Reveal 依赖 `subprocess`/平台工具 | 功能缺失 | 失败只返回错误文案 |
| 9 | 注册表使根集合可变而 M2 文案是快照 | prompt cache | 变更频率=用户增删频率；快照每次请求重渲染 |
| 10 | 增加两行 insert 改变组合面 | 组合门禁失效 | `patch.spec.ts` + `smoke:compose` 同步更新并在计划写明新期望 |

## 文档影响

新增：本文件、ADR-0004、ADR-0005、调研 §11。
更新：架构文档 §7（改标为已实现 + 机制描述）、需求文档 §7/§9、开发流程（命令、双面构建、jsdom 车道、冒烟清单、troubleshooting）、路线图 M3 段与状态头、`docs/plans/README.md`（中英）、根 `README.md`/`README.en.md`、`AGENTS.md` 当前状态。
SSOT 分工：设计事实 → 架构文档；验收判定 → 需求文档；上游事实 → 调研文档；排期/任务/验证证据 → 本计划。

## 完成判据

1. 「目标与成功标准」9 条逐条可复现，证据写入「实施结果」。
2. 空根零回归与多根注册表路径同时成立。
3. `docs:check` 0 error；架构/需求/调研/路线图/计划之间无矛盾表述；计划移入 `completed/`。
4. 双运行时（`0.1.5-rc.2` / `0.1.2-rc.1`）三个冒烟均通过，skip 项显式说明原因。
5. 上游仓库零改动。

## 假设与开放问题

- 假设 A：接受「面板 = 侧栏底部动作 + 对话框」而非 0.1.5 专属全屏面板；如果更看重全屏面板，则放弃 `0.1.2-rc.1` 兼容（两者不可兼得）。
- 假设 B：journey smoke 用脚本化模型而不是真实 API key（CI 无凭据可用；真实模型轮次可由开发者用 `DEEPSEEK_API_KEY` 手动复验）。
- 假设 C：命令文案英文可接受（面板双语）。
- 开放：命令文案的 host 侧本地化方案；`workspace_roots` 工具结论取决于 T10 证据；将来切 `per-record` layout 的键方案（ADR-0004 记录触发条件）。

## 实施结果（2026-09-12）

| 门禁 | 结果 |
| --- | --- |
| `pnpm lint`（oxlint） | 0 warnings / 0 errors（37 个文件，含 `.tsx`） |
| `pnpm typecheck` | 两面程序均通过（`tsconfig.host.json` + `tsconfig.client.json`） |
| `pnpm test`（vitest） | **167 项：164 passed / 3 skipped**（3 项为真实受限执行，宿主不可用） |
| `pnpm build` | host `lib/*.js`（ESM，含共享 chunk）+ `lib/client.js`（CJS 闭包工厂）+ 两面 `lib/types/**/*.d.ts` |
| `pnpm smoke:compose` | **34/34 checks passed**（组合差分：2 行 disabled + 5 行 insert） |
| `pnpm smoke:behavior` | **92/92 checks passed**（4 项显式 skip：受限 bash 执行 ×2、多根受限 bash ×2） |
| `pnpm smoke:journey` | **25/25 checks passed**（2 项显式 skip：web/headless 的受限 bash） |
| `pnpm docs:check` | 0 errors |
| 双运行时矩阵 | 三个冒烟在 `0.1.5-rc.2`（pin）与 `0.1.2-rc.1`（已安装桌面运行时）上均通过：34/34、92/92、25/25 |

用例分布：`roots.spec.ts` 29、`registry.spec.ts` 12、`command.spec.ts` 20、`client-bundle.spec.ts` 8、`client-panel.spec.tsx` 13、`locale-parity.spec.ts` 6、`scope.spec.ts` 15、`patch.spec.ts` 7、`fs-parity.spec.ts` 7、`dialects.spec.ts` 23、`sandbox-passthrough.spec.ts` 8、`sandbox-multi-root.spec.ts` 9、`parity-matrix.spec.ts` 10（3 skipped）。

交付物：`src/roots.ts`、`src/registry.ts`、`src/command.ts`、`src/contract.ts`（新）；`src/index.ts`、`cordis.patch.yml`、`tsdown.config.ts`、`tsconfig.host.json`、`tsconfig.json`、`.oxlintrc.json`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.github/workflows/ci.yml`、`.github/workflows/upgrade.yml`（新）、`scripts/lib/dsh-runtime.mjs`、`scripts/lib/profile-boot.mjs`、`scripts/smoke-compose.mjs`、`scripts/smoke-behavior.mjs`、`scripts/smoke-journey.mjs`（新）、`scripts/check-docs.mjs`；`src/client/{index.ts,locales.ts,panel-client.ts,WorkspaceFoldersAction.tsx}`（新）；`tests/{roots,registry,command,client-bundle,locale-parity}.spec.ts`、`tests/client-panel.spec.tsx`、`tests/support/registry-stack.ts`（新）；以及本文件、ADR-0004、ADR-0005、调研 §11 与架构/需求/开发流程/路线图/README/`AGENTS.md` 的同步更新。上游仓库零改动。

### T0 探查结论（写入调研 §11）

1. **存储 API 双运行时同形**：`defineDomain` / `domainTable` / `DomainSpec` / `KvTable` 在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 上逐项一致，注册表行无需版本分支即可两边激活（双运行时冒烟证实）。
2. **写入不做 schema 校验、`single` layout 无独立文档可备份**：因此"损坏存储"在 `single` layout 下会退化为整次 open 拒绝 → 决定降级语义（ADR-0004 决策 7）。
3. **组合位置**：`storage*` / `commands` / `typert` 在 base（web 与 headless 都有），`workspaceRegistry` 只在 web-app → 键必须是 canonical 主根。
4. **命令没有 argv 设施**、headless 没有派发方 → 子命令语法自解析，headless 侧由冒烟/测试用 `ctx.commands.execute` 驱动。
5. **目录选择**：host seam `ctx.directoryPicker.capability()` 与 client `ctx.uiWorkspace.pickDirectory()`；两个 `directoryFlow` 洞属于"创建工作区"，不能占用。
6. **Typert 生成与 client remote 清单都要求上游参与** → 出树通道改用 Connection RPC（ADR-0005）。
7. **两个运行时的 slot 面不同**：只有 `sidebar.footer.action` 是交集中的 additive 座位 → 面板落点（ADR-0005）。
8. **进程内驱动真实轮次**需要三件事：`provideCmdline`（web 组合）、`installModelSelection`（否则 persona 变量 `{{model}}` 缺失）、以及在 web 组合里 `agentPresets.mount`（否则工具解析面对空层，报 `unknown tool`）。

### 与计划的偏差

- **`workspace_roots` 工具**：按 T10 的闸门**不做**。证据是旅程断言两个 profile 的模型请求体里都出现拓扑快照（附加根路径 + "additional roots of this session's workspace" + cwd 不变）。限制：旅程的模型是脚本化的，因此这只证明"拓扑到达模型"，不证明"真实模型能自行发现"；需求 §9 的删除条件按快照证据判定为满足，已在需求文档记录。
- **`@deepseek-ai/dsh-loader-smoke` 未使用**：计划里打算用它的 `runFixtureTurn` 驱动轮次，实施时改为用运行时的 `@deepseek-ai/dsh-agent` + `@deepseek-ai/dsh-llm` 自己驱动（约 5 行），因此该 devDependency 已移除，避免多一份不由本仓库控制的测试运行时。
- **headless 腿的注册来自存储文件**：headless 没有命令派发方，旅程的 headless 腿通过预写注册表存储（domain 文档形态）完成登记——这同时是对"存储是唯一数据源"的一次实证；命令驱动路径由 web 腿与 behavior 冒烟覆盖。
- **`docs:check` 增加 `.dsh-smoke` 忽略项**：`DSH_SMOKE_KEEP=1` 保留的夹具里含有种子仓库的 README，会被误判为项目文档。
- **`.oxlintrc.json` 的 overrides 扩到 `.tsx`**：client 半部需要同样规则。
- **`allowBuilds` 增 `esbuild: false`**：jsdom/`@testing-library/react` 把 vite 的 esbuild 拉进树后，pnpm 的构建脚本门禁会拦下 `pnpm install --frozen-lockfile`；esbuild 的平台包是直接依赖，其安装脚本不需要运行。

### 留给后续

- Windows 内核级多根（pwsh / ACL）与 `workspace-files` 多根 confine。
- 命令输出文案的 host 侧本地化。
- Electron 车道的自动化验证（当前为人工步骤），以及 0.1.5 专属的 `sidebar.panellist` + `main` 全屏面板形态。
- 若上游提供出树 remote 贡献注册表，把 Connection 通道迁移到 Typert（ADR-0005 已记录迁移路径）。


---

## 外部审查返工（2026-09-12，重新验收）

M3 首次实施完成后，一次外部审查提出 **8 项可定位问题（3 项建议作为发布阻断项）**，并在本机复现验证。本节记录根因、修复与重新验收证据；决策层面的变更已写入 [ADR-0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md) 的「返工补充」与 [架构文档 §4/§7](../../architecture/multi-root-workspace.md)，需求侧新增验收条款 §5.7.1–§5.7.3。

### 逐项修复与证据

复现基线：本机 `./node_modules/.bin/vitest`、node v22.23.1；每个问题先以临时探针复现（探针已删除），再写成常驻回归测试。

| # | 审查发现（复现结论） | 根因 | 修复 | 回归测试 |
| --- | --- | --- | --- | --- |
| 1 (P1) | 登记 A 后删除 A 并建立 `A → B`，`registry.list` 仍报 `A: available`，而 `scope.scopeOf()`/`resolve()` 返回 **B**——授权被转移到未登记目录 | `sanitizeAdditionalRoots` 每次解析都重新 `canonicalPath(root.path)`（`realpath`），把"重新解析"当成"重新授权" | 登记项新增 `recordedPath`（登记时授予的 canonical 目录）；`scope` 与 `roots` 都只在 `canonicalPath(path) === recordedPath` 时授予，否则报 `redirected` 并撤销；恢复原目录后重新校验自动复原 | `tests/scope.spec.ts`「withholds a registration whose path was replaced…」、`tests/roots.spec.ts`「flags a record whose path now resolves elsewhere as redirected」、`tests/registry.spec.ts`「withholds a root whose directory was replaced, then restores it the same way」、`tests/command.spec.ts` 通道用例、`smoke:behavior` 三条换链断言 |
| 2 (P1) | `Promise.all([add(A), add(B)])` 两次都返回成功但只留下一条；`remove(A)` 与 `add(B)` 并发后**已删除的 A 复活** | `add/remove/setAlias/move` 在异步提交前读取快照，`commit` 只保证单次写入落盘；存储域的串行链只覆盖 `put()`，不覆盖读—改—写。**计划风险表第 3 条"domain 层按域串行化写入链即可"的结论是错的** | 新增 `serialize(key, job)`：同一 canonical 主根的"读快照 → 校验 → 落盘"整段入队；链尾吞掉 rejection，前序失败不阻塞后序 | `tests/registry.spec.ts` 新增 `describe('concurrent operations')` 四条（两个 add 并存、删除不被复活、四条并发按序生效、队列前序失败后仍可用） |
| 3 (P1) | 干净 checkout 上 CI 先跑 `test` 后跑 `build`，而 `tests/client-bundle.spec.ts` 读 `lib/client.js`（`/lib/` 被 gitignore，且无安装时构建钩子）→ 未构建即失败；本地残留 `lib/` 掩盖该问题 | 工作流步骤顺序错误 | `ci.yml` 与 `upgrade.yml` 统一为 `lint → typecheck → build → test → …`；新增 `kernel:probe` 步骤（见第 8 条相关的变化） | 本地等价验证：`rm -rf lib` 后跑制品 spec 得到 5 个 `ENOENT` 失败；`pnpm build` 后 8/8 通过；CI 顺序修正为静态核对 + 本地按序实跑 |
| 4 (P2) | 删除已登记目录后 `list`/面板仍显示 `available` 且仍授予；启动时缺失的目录恢复后，"刷新"也无法恢复授权 | 命令 `list` 与 RPC `list` 命中缓存直接返回，从不重查目录；文档承诺的"刷新即可恢复"实际不成立 | 新增 `registry.refresh(primaryRoot)`：重新 `stat` + 重新解析 + 重新裁决 + 重播种 scope + 通知监听者，**不写存储**；命令 `list` 与所有子命令、RPC `list` 都先走它；`publish` 改为幂等（授予集合或不可用集合未变则不动 scope、不重复告警） | `tests/registry.spec.ts`「revalidation without a restart」三条（消失→恢复、只读刷新不重写存储、仅在授予变化时通知监听者）、`tests/command.spec.ts` 命令与通道各一条重查用例、`smoke:behavior` 删除/恢复目录断言 |
| 5 (P2) | 输入 `/repos/typed` 后点"添加"，实际提交的是 picker 返回的 `/repos/picked` | 选择器按钮、手输确认与 Enter 共用 `addDirectory`，且 `picked ?? manualPath` 让 picker 结果优先 | 拆成 `addViaPicker()`（只提交 picker 结果，取消/无 picker 时什么也不做）与 `addManualPath()`（只提交手输内容，提交后清空输入）；Enter 与确认按钮绑后者。无 picker 时不再渲染 picker 按钮 | `tests/client-panel.spec.tsx`：确认按钮 payload 为 `/repos/typed`、Enter 同样、打开 picker 不改写也不清空手输框 |
| 6 (P2) | Reveal 成功后仍出现错误提示（使用真实返回形状替换 mock 后稳定复现） | host `reveal` 返回 `{ revealed: path }`，客户端把所有端点应答都按 `RootsView` 解析；原 mock 对所有端点返回列表，掩盖了契约不一致 | 契约显式化：`contract.ts` 的 `PanelResponseMap` 规定每个端点的应答类型，`reveal → RevealedView`、其余 `→ RootsView`；`PanelClient.call` 按端点返回相应类型，面板对 Reveal 单独处理（成功不动列表、不写错误） | `tests/client-panel.spec.tsx`：桩按端点返回真实形状（`reveal` 返回 `{ revealed }`）、Reveal 成功无 `role="alert"` 且列表不变、Reveal 应答形状不对时显示本地化错误；`tests/command.spec.ts` 断言 reveal 的 value 恰为 `{ revealed }` |
| 7 (P2) | 手写两条同 id 记录后两条都是 `available` 且都被授予；`remove(id)` 一次删掉两条 | `classifyStoredRoots` 只检查 id 非空，不检查唯一性；删除按 id 过滤 | 读取时若同一 id 出现在多条记录中，这些记录**全部** `invalid` 且不授予；新增按位置/路径/首次匹配删除**一条**的 `removeStatusAt` + `registry.removeAt()`，命令与面板的 remove 都走它 | `tests/roots.spec.ts`（重复 id 全部 invalid、`removeStatusAt` 只删一条）、`tests/registry.spec.ts`「a store with records that cannot be told apart」两条（含缺少 `recordedPath` 的旧记录）、`tests/command.spec.ts` 重复 id 逐条删除 |
| 8 (P2) | 空登记表时主根的子目录、以及包含主根的祖先目录都能登记 | `validateRootCandidate` 只把主根与候选做"相等"比较，重叠判断只针对 `existing` | 主根纳入双向重叠校验，错误码 `primary-overlap`（与 `equals-primary` 区分）；存储读取侧同样适用；`validateRootCandidate` 的注释同步说明规则顺序 | `tests/roots.spec.ts` 四条（主根子目录、包含主根、detail 点名主根、nested 仍报 nested）、`tests/registry.spec.ts` 校验用例 |

### 代码质量意见的处置

- **契约与状态生命周期**：`PanelResponseMap` 建立端点到应答类型的映射；请求体与应答两端都做运行时 `zod` 校验（同一份 schema 在 `src/contract.ts`，不新增依赖），host 把非法请求回报为 `panel/bad-request`；`refresh` 统一了"声明 / 缓存 / 实际授予"的更新时机（唯一入口，且只读刷新不落盘）。
- **测试不再只覆盖顺序成功流程**：新增并发增删、删除后复活、根目录替换、缺失恢复、重复 id、主根嵌套、真实 RPC 应答形状、面板手输路径、Reveal 契约、严格内核 runner 等用例（总数 164 → 204，skip 仍为 3 且仅因本机无法嵌套内核沙箱）。
- **文档过期承诺已修正**：「每次读取校验」现在是事实（`refresh`），「刷新即可恢复」也在 README 与开发流程里按真实语义重写；计划风险表第 3 条的错误结论在本节显式更正。
- **内核测试的 skip**：新增 `DSH_REQUIRE_KERNEL_RUNNER` 严格模式与 `pnpm kernel:probe`，并在 CI 中作为独立步骤——宿主确实能受限执行时，parity 矩阵与 behavior 冒烟的内核断言**必须真跑**，skip 即失败；宿主不能执行时打印原因并继续（CI 不会被受限镜像打死）。本地已验证两种路径：正常跑 3 skip，`DSH_REQUIRE_KERNEL_RUNNER=1` 时 3 条转为失败并给出原因。

### 重新验收证据（2026-09-12）

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:/opt/homebrew/bin:$PATH"
export CI=true                                  # 见开发流程 §8（pnpm 依赖自检在无 TTY 下会中止）
pnpm lint          # 0 warnings, 0 errors（37 files）
pnpm typecheck     # host + client 两面通过
pnpm build         # lib/*.js + lib/client.js（含内联的契约校验）
pnpm test          # 13 files / 204 passed | 3 skipped（基线 164 passed | 3 skipped）
pnpm kernel:probe  # seatbelt runner-failed（宿主沙箱禁止嵌套）、bwrap/landlock 不可用 → 内核断言显式 skip
pnpm smoke:compose # 34/34
pnpm smoke:behavior# 92/92（含新增的删除/恢复/替换目录断言），4 项内核受限 skip
pnpm smoke:journey # 25/25（web + headless 两 profile），2 项内核受限 skip
pnpm docs:check    # 0 errors
```

干净构建验证（针对第 3 项）：`rm -rf lib` 后制品 spec 5 项 `ENOENT` 失败；按修正后的顺序 `pnpm build && pnpm test` 全绿。

**未在本机验证的项（如实记录，不计为通过）**：GitHub Actions 真机执行（顺序为静态核对 + 本地等价序列实跑）、真实受限内核执行（本机 `sandbox-exec: sandbox_apply: Operation not permitted`，由 CI 严格模式覆盖）、`0.1.2-rc.1` 桌面运行时的双运行时矩阵（本次未重跑 `DSH_CLI=… pnpm smoke`）。

### 返工交付物

`src/contract.ts`、`src/roots.ts`、`src/scope.ts`、`src/registry.ts`、`src/command.ts`、`src/client/panel-client.ts`、`src/client/WorkspaceFoldersAction.tsx`、`src/client/locales.ts`；`tests/{roots,scope,registry,command,client-panel,parity-matrix,sandbox-multi-root,fs-parity}.spec.*`、`tests/support/kernel-runner.ts`（新）；`scripts/check-kernel-runner.mjs`（新）、`scripts/smoke-behavior.mjs`、`scripts/smoke-journey.mjs`、`package.json`、`.github/workflows/{ci,upgrade}.yml`；以及本文件、ADR-0004、架构 §4/§7、需求 §3/§5、开发流程、README（中英）。上游仓库零改动。
