# 现状调研：官方仓库 Workspace / Sandbox / 插件体系

> 本文是对上游官方仓库（deepseek-harness）在 master `c291e7961a`（2026-09-12）的现状快照调研；所有路径相对该仓库根，事实以该提交为准，后续如上游演进需重新核对。本文是 [multi-root-workspace.md](../requirements/multi-root-workspace.md) 与 [multi-root-workspace.md](../architecture/multi-root-workspace.md) 的事实依据。
> §8 为"不改上游"约束下的补充调研（2026-09-12 第二轮）。

## 1. Workspace 模型：单目录注册表

实现只有一个包：`packages/workspace/workspace`（`@deepseek-ai/dsh-workspace`）。

- `src/types.ts`：`WorkspaceId` 是 branded uuid（明确注释"绝不是路径"）；`Workspace` 记录 `id`、`path`（创建时 `fs.realpath` 得到的 canonical 目录，之后永不改写）、`sessionIds`、`setTitle` / `attachSession` 等。
- `src/index.ts`：`WorkspaceRegistry extends Service`（`ctx.workspaceRegistry`，`inject = ['storageDomain', 'sessionPersistence']`）。`create(path)` 用 `realpathNormalize`（`src/paths.ts`，realpath + 规范化）canonical 化后存储；启动时 `bootstrap()` 按所有持久化 session 的 header cwd 自动建 workspace。
- 持久层：`src/spec.ts` 的 `WorkspaceRecord { path, title, sessionIds, createdAt, updatedAt }`，经 `dsh-storage-domain` 的 `workspaces` KvTable 持久化。
- **Session 与 workspace 的唯一联结是不可变的 session header cwd**（`packages/core/session/src/types.ts` 的 `SessionHeader.cwd`，创建时校验必须是绝对路径，此后不可变）。membership = session 的 canonical cwd == workspace.path。
- Session 创建入口：`packages/api/session-controller/src/commands.ts`（约 88-120 行）接受 `workspaceId` XOR `cwd`，`cwd = workspace?.path ?? request.cwd ?? defaultCwd`，随后 `workspace.attachSession(sessionId)`；fork 从 `source.header.cwd` 继承。
- 消费方：`packages/api/workspace-controller/`（CRUD / feed 远程 API）、`packages/api/workspace-files/`（Client 文件读取，`confine(root, workspaceRoot, path)` 限定在 header cwd 内）、`packages/util/workspace-path/`（Client 展示辅助）。

**结论**：需求文档第 6 节"保持 Workspace.path 作为 Primary Root、第 7 节不改 Session cwd"与现状完全吻合——`workspace.path` 与 `header.cwd` 都已经是 canonical realpath，插件不需要为此做任何事，只需要不碰它们。

## 2. Sandbox 作用域：单根模型，语义 home 在上游内部

作用域没有 allowedPaths 数组，词汇只有一个：

```ts
// packages/sandbox/sandbox/src/index.ts
export interface SandboxExecutionPolicy {
  mode: SandboxMode            // 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string        // 绝对路径，单一根
  sessionId?: SessionId        // Windows ACL 派生 per-session 临时授权用
}
```

**Policy 解析唯一入口**：`packages/sandbox/sandbox-policy/src/index.ts` 的 `SandboxPolicyService`（`ctx.sandboxPolicy`）：`resolve({ session })` 返回 `{ mode, workspaceRoot: realpath(session.header.cwd), sessionId? }`，无 session 时退回部署配置根。`SandboxPolicyRequest` 只有 `{ session?, mode? }`。

**语义唯一 home**：`packages/sandbox/sandbox/src/roots.ts` 的 `writableRoots(policy)`：`workspace-write` 时返回 `[workspaceRoot, '/tmp', tmpdir()]` 的 canonical 去重集合。模块注释明确这是唯一语义 home，fs fence 与 Seatbelt 都从这里取 allow-list；bwrap / Landlock 保留各自 grant 拼写，parity 由测试钉住。`canonicalPath` 用 `realpathSync.native`（逐组件解析，与 chdir/spawn 匹配；解析失败原样返回——缺失的根匹配不到任何东西，保守结果）。

**消费方（enforcement 方言）**：

| 方言 | 位置 | 如何取根 |
|---|---|---|
| Seatbelt (macOS) | `packages/sandbox/sandbox-local/src/profiles.ts` `seatbeltProfileArgs` | 直接用共享 `writableRoots()`（第 53 行附近） |
| bwrap / Landlock (Linux) | 同上 `bwrapProfileArgs` / `landlockProfileArgs` | 自己的 grant 拼写，parity 测试钉住 |
| Windows ACL | `packages/sandbox/sandbox-local/src/index.ts` `materializeAclGrant`（约 392-412 行）+ `packages/sandbox/sandbox-windows-acl/src/grant.ts` | 以单个 `policy.workspaceRoot` 为参数 |
| 进程内 fs fence | `packages/fs/fs-sandbox/src/index.ts` `SandboxedFileSystem.checkedTarget`（约 122-144 行，TS private）+ `src/containment.ts` `isPathUnder`（词法 + stat dev/ino 双重包含） | `isPathUnder(target, policy.workspaceRoot)`；违规抛 `FS_SANDBOX_DENIED`；**读操作完全不过栅栏** |
| e2b | `packages/e2b/` | 不消费 policy（VM 隔离） |

**工具层取 policy 的方式（全部同一份）**：bash（`packages/shell/tool-bash` 约 193-199、339 行 → `SandboxBashExecutor`）、fs（`packages/fs/tool-fs/src/sandbox.ts` `FsSandboxController` → `write.ts`/`edit.ts` 把 policy 传进 `writeText`/`editText`）、terminal（`packages/terminal/terminal-bash/src/index.ts` 约 194-199 行，`policy.workspaceRoot` 作默认 cwd）。升级（escalation）API（`ESCALATION_TARGETS / approveEscalation / sandboxDenialMarker`）bash 与 fs 共用，**只放宽 mode，不放宽 root**。

**读操作当前完全不受限**（fs fence 不设读栅栏）。多根首先改变的是"可写范围"与"bash 执行范围"。

## 3. 会话级策略状态：`sandbox/mode` 先例

`packages/sandbox/sandbox-policy/src/session-mode.ts`：log-only session 事件 `sandbox/mode` + projection unit（fold 取最后事件）+ 唯一写路径 `setSandboxMode(session, mode)`；生效于下一次受限调用。policy 的文案经 `ctx.systemPrompt.context({ name: 'sandbox:policy' })` 进入 runtime-context 快照，**该快照被 agent loop 落入 model history**（模块头注释明说 replay 可重建）——即 "Model-visible ⟺ logged" 由快照落 log 满足。

**自定义事件兼容警告**（AGENTS.md / session-format 规则）：`SessionEventMap` 成员默认 required-on-read——**不知道某事件类型的 dsh 构建会拒绝打开该日志，除非事件信封带 `ignorable: true`**。out-of-tree 插件若无限制地 append 自有事件类型，会使会话日志对未装插件的 dsh 不可读（fork/迁移/共享日志场景都会踩）。

## 4. 插件编写机制（本功能需要的部分）

- 插件形态：导出 `name` / `inject` / `Config` / `apply(ctx, config)` 的 ES 模块，或 `Service` 子类（Service 包 default-export 服务类，不能与 `apply` 混用）。教程：`docs/user/develop/basic/index.md`。
- Config：schemastery（`static Config` 或导出 `Config`），cordis.yml 行 `config:` 由 Loader 校验；生成目录 `docs/config-catalog.md`。
- 注册全部走 effects：`ctx.effect()` / `ctx.on()` / 各 registry 的 `register()`（返回 disposer），随插件 fiber 卸载自动回退。
- Capability Seam 三角色（`docs/architecture.md` §Capability seams）：Service Definition（声明接口 + `declare module` 挂 `ctx` key）/ Service Provider / Consumer。fs、web、shell 是完整三件套范本。
- 持久化：`@deepseek-ai/dsh-storage` + `dsh-storage-json` + `dsh-storage-domain`（schema 校验 domain form）；插件持久数据走这条链。
- 工具：`inject: ['tools']` + `ctx.tools.register(defineTool({...}))`（`docs/cookbook/adding-a-tool.md`）；命令：`ctx.commands.register(definition)`；System prompt 注入：`ctx.systemPrompt.section(...)` / `.context(...)`（均为公开 API）。
- 投影：`ctx.sessionProjections.register` 是公开 API（`packages/session/session-projection/src/index.ts:233-291`），注册是调用者 fiber 上的 effect，插件 apply 期调用即可（上游 `SandboxPolicyService` 自己就在构造函数里调）；`session.append` 运行时只要求 JSON 可序列化，事件类型经 module augmentation 开放。

## 5. UI 层现状（Web Client + Electron 桌面壳）

- UI 是浏览器 Web GUI（`dsh --profile web`），另有 **Electron 桌面应用**（`apps/desktop`）：自带 dsh runtime 与 client graph，保留 `$DSH_HOME/profiles/desktop` 装外部插件；桌面端与 CLI profile 共享产品数据，本功能两端一致可用。
- Client 插件模型：`packages/client/ui-*` 包；package.json 声明 `dsh.client: { platform, inject, ... }`，导出 `./client`；`packages/client/modules` host 侧扫描 `dsh.client` 声明组成 boot graph 经 `/plugins` 下发。UI 扩展点是 slot 系统（`packages/client/ui-slots` + `docs/subsystems/slots.md`）：`ctx.slots.inject(slotName, fn)` + `ctx.slots.register({ name, key, locale, inject }, Component)`。
- **Workspace UI 已有骨架**：`packages/client/ui-workspace`（WorkspacePicker、分组树、导航）；预留 slot 洞 `sidebar.workspaces.directoryFlow` 与 `conversation.hero.workspace.directoryFlow`（single kind），**"Add workspace..." 动作只在洞被占据时渲染**。
- **Directory Picker 已成体系**：Host seam `packages/host/directory-picker` + `directory-picker-native`（Windows 原生对话框）+ `directory-picker-browse` + `directory-picker-auto`；远程控制器 `packages/api/workspace-controller/src/directory-picker.ts`（Typert 命名空间 `directoryPicker`：`pick` / `list` / `createDirectory`）。其 README 写明："**No multi-root support — waits for a consumer that needs it**"。
- i18n：locale-owned 文案（`ctx.locale.register(ns, { zh, en })` + slot `locale` 命名空间 → `t`），`verify-client-ui-i18n` 门禁拒绝硬编码文案。

## 6. 交互 / SDK / 其他相关面

- approval（`packages/interaction/user-approval`）与 ask-user（`packages/interaction/user-questions`）是现成人机问答通道；"Add Folder" 类交互直接走 `directoryPicker.pick` 即可。
- TS SDK（`packages/sdk`）与 Python SDK 协议面只有 session/prompt + 事件流，**没有 workspace / filesystem API**；SDK 驱动多根配置需经 Typert Remote 命名空间。
- 需求文档第 2 节提到的 "Workspace Memory / Workspace MCP / Workspace UI 插件" 在本仓库中不存在——本仓库就是 DSH 本体；插件生态 = `packages/` 内置插件 + 外部 bundle 两种形态。

## 7. 缺口清单

1. 可写根集合单根（语义 home 在上游 `writableRoots()` 与各方言内部）。
2. policy 的 systemPrompt context 文案只描述单根。
3. Root 注册表 / canonicalization / 冲突校验 / 持久化（需新建）。
4. Add Folder / Remove / Alias / Reveal UI（需新建，复用 directoryPicker 与既有 slot 洞）。
5. 可选 `workspace_roots` 内省工具。

## 8. 补充调研：不改上游（纯 out-of-tree 插件）的可行机制

> 第二轮调研，针对约束"不得修改当前仓库 packages/ 下任何包"。全部结论带文件出处。

### 8.1 patch 层能力与边界（`vendor/include/src/index.ts:58-128` `applyEntryPatches`）

- patch 行可以覆盖既有行的 `config`、`disabled` 等任意 key（`disabled` 已有 `!!js process.platform === 'win32'` 先例，`packages/bundle/base/cordis.patch.yml:216`）；**但不能改 `name`**——patch 行里的 `name` 只用作匹配断言，不匹配则 warn + skip。
- 所以**替换一个 provider 的正确姿势 = disable 旧行 + insert 新行**（insert 支持包名 / 绝对路径 / file URL，`packages/boot/app-boot/README.md:59`）。
- patch 替换是整份 config，不 deep-merge（`app-boot/README.md:144`）。
- 层顺序：bundle 按 `dsh.profile.bundles` 列表序 → profile patch → home patch → `--patch`；**后面的层可以 patch 前面的层（含 base bundle）insert 或已有的行**（`vendor/include` 的 buildMap 保证）。

### 8.2 同 key 重复 provide 会抛错（`vendor/cordis/src/reflect.ts:277-300`）

```ts
if (this.store[key]) {
  throw new Error(`service "${name}" has been registered at <...>`)
}
```

同一作用域内第二个提供 `fs` / `sandbox` 的插件激活时直接 throw——必须先 disable 上游行再 insert 自己的行。

### 8.3 关键上游类均可 import、可子类化（全部 exports 含 `"."` 与 `"./src/*"`；无 `#` true-private 字段）

| 类 | 位置 | TS-private 成员 | 可 override 的关键 public 方法 |
|---|---|---|---|
| `SandboxedFileSystem extends LocalFileSystem` | `packages/fs/fs-sandbox/src/index.ts:55` | `defaultMode`、`checkedTarget`(:122) | `sandboxMode` getter(:65)、`writeText`(:80)、`editText`(:101) |
| `SandboxBashExecutor extends LocalBashExecutor` | `packages/shell/bash-sandbox/src/index.ts:45` | `mode`、`processFacts`、`confine`(:179) | `sandboxMode`(:76)、`resolve`(:85)、`run`(:89)、`start`(:117)、`onProcessDone`(:151, protected) |
| `SandboxPolicyService` | `packages/sandbox/sandbox-policy/src/index.ts:109` | 无 | `resolve`(:163)、`overrideOf`(:177) 全 public |
| `LocalSandboxProvider extends SandboxProvider` | `packages/sandbox/sandbox-local/src/index.ts:250` | 多个 TS-private 状态字段 | `confine(argv, policy)`(:316) 是 **public**；`internals` 是 public |
| `LocalFileSystem` | `packages/fs/fs-local/src/index.ts:65` | `locks` | 全部抽象方法 public（`resolve` :107、`writeText`、`editText` 等） |

注意：`SandboxedFileSystem.checkedTarget` 是 TS-private，跨包子类**不能**以类型安全方式 override/调用它；但其单根逻辑在 `writeText`/`editText` 内部——子类要么 `extends LocalFileSystem` 自己实现 containment，要么运行时原型替换（不推荐）。`isPathUnder`（`fs-sandbox/src/containment.ts`）经 `"./src/*"` 深导入可达。

### 8.4 不可行的"软"扩展点（排除依据）

- **`fs/*` 事件不能放行**：`fs/write-intent` 是 single-slot decision，返回值只能是 `{ kind: 'createIfAbsent' } | { kind: 'replaceIfVersion' }`（`packages/fs/fs/src/types.ts:123-125`），不触及 policy/路径；waterfall 在 fence **之前**，而 fence 在 provider 的 `writeText`/`editText` 内部（`packages/fs/tool-fs/src/write.ts:105-124`）。`fs/observed` 是纯 emit。
- **`tools/pre-execute` 不能改写参数**：`PreToolDecision = { allow } | { deny, reason } | { ask }`，类型注释明说 "Input rewriting is excluded because arguments are already logged and presented"（`packages/core/tools/src/index.ts:135-144`）；`tools/execute` waterfall 只允许改 `exec.signal`。
- **替换 `sandbox-policy` 也表达不了多根**：`SandboxExecutionPolicy.workspaceRoot` 是单值，`writableRoots()` 与所有方言只读它；escalation 只放宽 mode。
- **`LocalSandboxProvider.Config.runnerCommand`** 可换 runner argv，但 profile 参数仍由上游按单根 `policy.workspaceRoot` 拼装（`sandbox-local/src/profiles.ts:20,33,51-55`），换 runner 换不了多根语义。

### 8.5 外部 bundle 安装与组合（`apps/cli/src/plugin.ts`）

`dsh plugin --profile <name> add <package>`：git/path/tarball/alias spec 均支持；安装后**包内 `dsh.bundle.patch` 自动追加进 `dsh.profile.bundles`**（`reconcilePlugins` :59-91）；bundle 目录双锚解析（dsh 安装 / profile 目录，`app-boot/src/profile.ts:746-757`）。外部 bundle 排在 base 之后即可 patch base 的行。

### 8.6 结论排序（不改上游实现"多根 workspace-write"）

- **路径 A（唯一语义正确、推荐）：patch disable + insert + 子类化**。disable `fs-sandbox` / `bash-sandbox` / `sandbox` 三行，insert 自己的 provider（fs、shell、sandbox 三个 key），子类实现多根 containment 与多根方言 grant。代价：方言 parity（fs fence vs 内核 runner 的根集合一致）从上游测试转移到插件自己维护；上游 pre-stable（AGENTS.md 明言 "Public APIs are pre-stable"），升级可能破坏子类，必须 pin 版本 + 升级 smoke。
- **路径 B（fs/* 事件放行）：不可行**（8.4）。
- **路径 C（tools/pre-execute 改写）：不可行**（8.4）。
- **路径 D（`extends FileSystem` 自带完整 provider）：长期形态**。升级韧性最好（只依赖 Service Definition 抽象类），但要重做原子写、edit 临界区、锁等（参考 `fs-local/src/fsio.ts`），内核方言问题同样要解；可作为 A 稳定后的演进方向。
- **辅助（不独立成立）**：`ctx.sandboxPolicy` 子类无法表达多根；`runnerCommand` 换 runner 不换语义；`dsh plugin add` 载体无障碍。
