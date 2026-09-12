# 现状调研：官方仓库 Workspace / Sandbox / 插件体系

> 本文是对上游官方仓库（deepseek-harness）在 master `c291e7961a`（2026-09-12）的现状快照调研；所有路径相对该仓库根，事实以该提交为准，后续如上游演进需重新核对。本文是 [multi-root-workspace.md](../requirements/multi-root-workspace.md) 与 [multi-root-workspace.md](../architecture/multi-root-workspace.md) 的事实依据。
> §8 为"不改上游"约束下的补充调研（2026-09-12 第二轮）；§9 为发布形态与运行时解析的补充调研（2026-09-12 第三轮，安装形态下必须遵守的事实）；§10 为 M2 期实测的方言形状与子类可用面（2026-09-12 第四轮，是 [ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md) 的依据）。

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

- **路径 A（唯一语义正确、推荐）：patch disable + insert + 子类化**。disable 上游的 fs 与 sandbox provider 行，insert 自己的同 key provider（外加插件自有 scope 服务），子类实现多根 containment 与多根方言 grant。代价：方言 parity（fs fence vs 内核 runner 的根集合一致）从上游测试转移到插件自己维护；上游 pre-stable（AGENTS.md 明言 "Public APIs are pre-stable"），升级可能破坏子类，必须 pin 版本 + 升级 smoke。
  - 收窄说明（见 §9.3）：bash 侧的 confinement 全部经 `ctx.sandbox`（`SandboxBashExecutor.confine` → `ctx.sandbox.confine`；PTY 同理），执行器不掌握根集合，因此 `bash-sandbox` 不必替换，替换集合由三行收窄为两行（[ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)）。
- **路径 B（fs/* 事件放行）：不可行**（8.4）。
- **路径 C（tools/pre-execute 改写）：不可行**（8.4）。
- **路径 D（`extends FileSystem` 自带完整 provider）：长期形态**。升级韧性最好（只依赖 Service Definition 抽象类），但要重做原子写、edit 临界区、锁等（参考 `fs-local/src/fsio.ts`），内核方言问题同样要解；可作为 A 稳定后的演进方向。
- **辅助（不独立成立）**：`ctx.sandboxPolicy` 子类无法表达多根；`runnerCommand` 换 runner 不换语义；`dsh plugin add` 载体无障碍。

## 9. 发布形态与运行时解析（2026-09-12 第三轮补充）

> 本节记录"不改上游"插件在**安装形态**下必须遵守的事实。§9.3 的取根路径是收窄替换集合的依据（[ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)），§9.1/§9.2 是"只允许包入口导入 + 精确 pin"的依据（[ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)）。

### 9.1 发布包里没有源码

对 `@deepseek-ai/dsh-fs-sandbox@0.1.5-rc.2` 的发布 tarball 实测，包内只有 8 个文件：

```text
package/LICENSE
package/README.md
package/README.zh.md
package/README.i18n.yaml
package/package.json
package/lib/index.js
package/lib/types/index.d.ts
package/lib/types/containment.d.ts
```

- `package.json` 的 `files` 只声明 `lib/index.js` 与 `lib/types/**/*.d.ts`，**没有 `src/`**。
- 该包 `exports` 里确实声明了 `"./src/*": "./src/*"`，但在安装形态下这是**死路径**：目标文件不存在。
- `lib/index.js` 是打包后的单文件（内部 `containment` 已被内联，`lib/` 下没有独立的 `containment.js`），因此**包入口导入可用、深导入不可用**。
- 本机 profile 的 `node_modules` 中同名包带 `src/`，是指向应用内副本的符号链接造成的假象，不能作为"深导入可用"的依据。
- 推论：`pkg/src/*` 一律不得进入插件的运行时与构建依赖面；需要上游内部实现时改为本地实现 + 注明出处 + 差分测试钉住。

### 9.2 dist-tag 与可用版本（`@deepseek-ai/dsh-*`）

| tag | 版本 |
|---|---|
| `latest` | `0.0.1-rc.1`（陈旧，**不能使用**） |
| `alpha` | `0.1.5-alpha.2` |
| `next` | `0.1.5-rc.2`（最新） |

已发布序列包含 `0.1.2-alpha.2` … `0.1.2-alpha.5`、`0.1.2-rc.1`、`0.1.3-alpha.2`、`0.1.5-alpha.1/2`、`0.1.5-rc.1/2`。本机已安装桌面运行时的包版本为 `0.1.2-rc.1`。

推论：任何范围依赖（`^0.1`、`latest`）都会解析到错误版本；插件必须以**精确版本**声明开发/CI 目标，并用范围声明 `peerDependencies` 以兼容宿主已有副本。

### 9.3 bash 与 PTY 的取根路径

| 消费方 | 取根方式 | 出处 |
|---|---|---|
| 一次性 bash（`ctx.shell`） | `SandboxBashExecutor.confine` → `this.ctx.sandbox.confine(['bash','-c',command], policy)` | `packages/shell/bash-sandbox/src/index.ts` 约 177-179 行 |
| 交互式 PTY（terminal） | `spawnArgv` → `ctx.get('sandbox').confine(argv, policy)`；cwd 取 `policy.workspaceRoot` | `packages/terminal/terminal-bash/src/index.ts` 约 105-108 行 |
| 上游 `sandbox-policy` | `resolve()` 返回单值 `workspaceRoot`（会话则为 canonical cwd） | `packages/sandbox/sandbox-policy/src/index.ts` |

执行器与 PTY 都不计算根集合，因此多根只需在 `ctx.sandbox` 一处表达；替换 `bash-sandbox` 只是重复上游的 mode / escalation / process-facts 语义。

### 9.4 运行时解析锚点与 profile 机制

- profile 目录为 `$DSH_HOME/profiles/<name>`，其 `pnpm-workspace.yaml` 使用 `nodeLinker: hoisted` 且 `autoInstallPeers: false`：本地目录插件会被 pnpm 链接进来，而 peer 依赖不会被自动安装。
- `dsh plugin ...` 是 pnpm 的转发器：在 profile 目录里执行 pnpm，然后把"解析到 `dsh.bundle` 声明的依赖"回填进 `dsh.profile.bundles`。
- 启动时 `resolveBundleDir` 用"dsh 安装锚点 / profile 目录"双锚解析 bundle 包目录；`app-boot` 还会为 bundle 的依赖闭包建立 profile 级链接与模块回退目录，使包代码里的裸标识符（含 `@deepseek-ai/*`）能解析到宿主副本。
- 结论：插件的运行时应把上游包声明为 `peerDependencies`（由宿主提供单一份实例），并在冒烟中用 `instanceof` 断言"同一份服务定义与 cordis 实例"，而不是自带副本。

### 9.5 无凭据可用的验证面

- `dsh --profile <name> --dump-config`：输出合成后的配置树，按 `# == <bundle>` 分组，行内保留 `disabled: true` 与 `config`，可在隔离 `$DSH_HOME` 下离线运行，适合做"只差预期行"的组合断言。
- `boot(binName, absoluteConfigPath, patches, prepare?)`（`@deepseek-ai/dsh-app-boot`）：上游自身测试即在进程内挂载整棵配置树；据此可对 `ctx.fs` / `ctx.shell` / `ctx.sandbox` 直接做行为断言，**不需要 LLM 凭据**。
- 两者都只写隔离的 `$DSH_HOME`，不会污染用户真实 profile。

### 9.6 版本差异清单（`0.1.2-rc.1` vs `0.1.5-rc.2`）

逐字节相同：`fs-sandbox/src/index.ts`、`fs-sandbox/src/containment.ts`、`sandbox/src/roots.ts`、`sandbox-policy/src/index.ts`、`terminal-bash/src/index.ts`。

有差异：

| 文件 | 差异 |
|---|---|
| `sandbox-local/src/index.ts`、`sandbox-local/src/profiles.ts` | landlock 导入路径由 `@deepseek-ai/node-addon-landlock-run` 变为 `@deepseek-ai/node-addon-system/landlock-run` |
| `bash-sandbox/src/index.ts`、`bash-local/src/index.ts` | provider rejection 的表述与 `onProcessDone` 参数名改为 spawn failure（公开签名兼容） |
| `fs-local/src/index.ts` | 新增 `readByteRange`（纯增量） |

推论：双运行时矩阵是必要的，但插件的相关假设（类方法面、patch 行 id、policy 语义）在两个版本间是稳定的；不一致项集中在方言 runner 的导入细节，也正是"不要引用上游内部实现"的理由。

## 10. 方言形状与子类可用面（2026-09-12 第四轮，M2 实测）

> 本节是 M2「在单根 profile 上追加附加根」的实测依据（[ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md)）。全部结论来自在 pin 的 `0.1.5-rc.2` 上强制 `internals.chain` 后打印 `confine` 输出。

### 10.1 子类可用面：只有 `confine` 与 `internals`

`@deepseek-ai/dsh-sandbox-local` 发布 `.d.ts` 中 `runnerArgv`、`landlockLauncher`、`seatbeltExec`、`windowsAclRunnerArgv`、`windowsAclRunnerInvocation`、`selectRunner` **均为 TS-private**；`LocalSandboxProvider` 的公开成员只有：

| 成员 | 用途 |
| --- | --- |
| `confine(argv, policy): ConfinedArgv` | 唯一的包装入口 |
| `internals: SandboxInternals` | 公开测试钩子（`chain` / `platform` / `landlockLauncher` / `seatbeltExec` / `windowsAclRunnerArgs` / `probe*`） |
| `static Config` / `internals.rmTempDir` | 配置与清理钩子 |

因此子类只能从 `confine` 的**输入输出**推断方言；这是"识别失败即抛错"设计的直接原因。

### 10.2 `confine` 的输出结构

```text
argv = [...profileArgs, '--', ...callerArgv]
```

- profile 段**不含**裸 `--`（四种方言与 `runnerCommand` 都是如此），所以分隔符可由 `argv.length - callerArgv.length - 1` 精确算出；用法见 §10.3 的实测输出。
- `enforcement` / `denialSignatures` / `runnerFailureRules` 由所选 rung 决定，与 profile 段无关。

### 10.3 四种方言的 profile 段（workdir 用 `<ws>` 表示 policy 根）

```text
seatbelt     ['sandbox-exec', '-p',
              '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))
               (allow file-write* (subpath "<ws>") (subpath "/private/tmp") (subpath "<tmpdir>"))']
             read-only 时**没有** subpath form（roots 为空）
bwrap        ['bwrap', '--ro-bind','/','/', '--dev','/dev', '--unshare-pid', '--proc','/proc',
              '--die-with-parent', '--tmpfs','/tmp', '--bind','<ws>','<ws>']
             read-only 时没有 --tmpfs / --bind
landlock     ['<launcher>', '--ro','/', '--rw','/dev/null', '--rw','/tmp', '--rw','<ws>']
             read-only 时只到 '--rw','/dev/null'
windows-acl  ['node', '<runner>', '--workspace','<ws>', '--temp','<temp>', '--mode','workspace-write']
runnerCommand ['<operator runner>', ...bwrap 的 profile 段]（上游契约：追加 bwrap 兼容参数）
```

要点：

- **Seatbelt 的 roots 来自共享的 `writableRoots(policy)`**（canonical、去重），所以 `/tmp` 在 darwin 上是 `/private/tmp`，`tmpdir()` 是 `/var/folders/...`。多根追加只要在同一个 allow form 里再加 `(subpath "…")`。
- **bwrap 与 Landlock 使用各自的字面拼写**：bwrap 是挂 `--tmpfs /tmp` + `--bind <ws> <ws>`，Landlock 是 `--rw /dev/null,/tmp,<ws>`；两者都**不**授予 `tmpdir()`（除非它等于 `/tmp`）。这就是上游 `roots.ts` 注释里"honest per-runner differences"的具体形态，也是 parity 断言只对"附加根集合与模式"成立的原因。
- 字面 `/tmp` 与 darwin 的 `/private/tmp` 不是一个字符串：把 Linux 方言强制到 darwin 上跑时，临时区一行不可比（生产环境不会出现这种组合）。
- win32 的 ACL rung 用 workspace SID 授权、argv 里没有可追加的路径，因此第一期不能表达附加根。

### 10.4 哪些调用根本不会到达 `confine`

- `SandboxBashExecutor.run` / `.start`：`mode === 'danger-full-access'` 时直接走本地执行，不调用 `confine`。
- `terminal-bash` 的 `spawnArgv`：同一判断，`danger-full-access` 直接返回原始 argv。
- 因此 `confine` 只会看到 `read-only` / `workspace-write`；多根 grant 只需按 `workspace-write` 表达即可，`read-only` 必须保持原样。

## 11. M3 实测：注册表、命令与 client 半部（2026-09-12 第五轮）

> 本节记录 M3 实施前对上游与两个运行时的实测结论；它们决定了 [ADR-0004](../decisions/ADR-0004-root-registry-persistence-and-validation.md) 与 [ADR-0005](../decisions/ADR-0005-out-of-tree-client-transport.md)。

### 11.1 存储（`dsh-storage-domain`）在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 上同形

`defineDomain` / `domainTable(schema)` / `DomainSpec{ name, version, layout?, compatibleVersions?, invalidRecords?, global?, tables }` / `KvTable{ get, entries, keys, size, put, delete, update }` 在两个已安装运行时里逐项一致（0.1.2 的 `storage-domain/src/spec.ts` 与 pin 版逐行可比）。因此注册表行可以用同一份代码在两者上激活。

两条会影响设计的细节：

- **写入不做 schema 校验**，`open` 时才对已存记录做 zod 校验；`single` layout 下没有可备份的独立文档，`invalidRecords: 'backup-and-skip'` 实际退化为"整次 open 拒绝"。
- **`per-record` layout 的键必须匹配 `/^[a-zA-Z0-9_-]+$/`**，路径不能当键；`single` layout 下键是任意字符串，路径可以当键。

### 11.2 组合位置与命名空间

- `storage` / `storage-json` / `storage-domain` / `commands` / `typert` 都在 **base** 层（`packages/bundle/base/cordis.patch.yml:145-156`、`:286-287`、`:39-46`），web 与 headless 都继承；`@deepseek-ai/dsh-workspace`（`ctx.workspaceRegistry`）只在 **web-app** 层（`packages/bundle/web-app/cordis.patch.yml:75-76`），headless 没有。
- domain 名是进程级独占的：base 已用 `session_projcache`，web-app 已用 `workspace`；重名 `open` 抛 `already-open`。插件用 `multi_root_workspace`。

### 11.3 命令运行时

`ctx.commands.register({ name, description, input?, recordInput?, handler })`；`handler` 返回 `{ kind: 'success', text? } | { kind: 'error', text }`，注册表把 `command/run` / `command/done` 写进会话日志。**没有 argv / 子命令设施**：`execute(agent, line, …)` 只用 `parseCommand` 切出 `name` 与逐字 `rawInput`，子命令语法由 handler 自己解析（上游 `/goal` 是同一个模式）。headless 组合有注册表但**没有派发方**（派发方只有浏览器），所以 headless 侧只能进程内 `ctx.commands.execute(...)`。

### 11.4 目录选择

- host seam：`ctx.directoryPicker.capability()` 返回 `{ kind: 'native', pick(signal) }` 或 `{ kind: 'browse', list, createDirectory }`（`packages/host/directory-picker/src/index.ts:20-59,103-113`）；web-app 的 `host-directory-picker-auto` 行在启动时挑一个后端并把 host/client 两面都挂上。
- client：`ctx.uiWorkspace.pickDirectory() / listDirectory() / createDirectory()`（`packages/client/ui-workspace/src/client/navigation.ts:179-193`）。
- `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` 是 ui-workspace 为「创建工作区」声明的 `single` 洞，默认已被 `ui-directory-picker-native`/`-browse` 的 client 半部占用；owner 收到路径后调用 `createWorkspace`，与"给当前工作区加一个附加根"不是一回事。

### 11.5 出树 client 半部的现实

- `@deepseek-ai/dsh-typert-generator` 虽是公开包，但以 **workspace** 为单位分析：向上寻找 `tsconfig.host.json`、只接受 `<root>/packages` 下的工程引用，并要求包 manifest 预先声明 `./typert` / `./remote` 导出与 `files`（`packages/typert/generator/src/tsdown-plugin.ts:154-162`、`analyzer.ts:482-488`、`workspace.ts:96-145`）。单包出树仓库跑不通。
- client 侧 `@deepseek-ai/dsh-api-remotes/client` 按**固定清单** `$mount` 15 个第一方贡献（`packages/api/remotes/src/client/index.ts:3-30`）；`ctx.remote.$mount` 能挂任意贡献，但前提仍是"有生成好的贡献制品"。
- **公开且两个运行时都有的通道是 Connection RPC**：host `ctx.connection.rpc.handle(channel, handler)`、client `connection.rpc.call(channel, endpoint, payload)`（`packages/client/connection/src/rpc.ts:140-152,217-237`；`0.1.2-rc.1` 的同名文件同样导出）。已发布的出树插件 `@dsh-electron/dsh-plugin-git@0.2.0` 用的就是它。
- 模块加载器只接受一种 client 制品形状：CJS 闭包工厂（`window.__ModuleLoader__.load({ id, factory: (require) => … })`）+ `exports.apply` / `exports.inject`；发现路径是"已挂载 Loader 行所属包的 `exports['./client']` + `dsh.client.platform === 'web'`"（`packages/client/modules/src/index.ts:710-745`）。两个运行时的平台词交集是 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`（0.1.5 另加 `ui-dockkit`）。

### 11.6 slot 面在两个运行时不同

| 运行时 | 侧栏可见的根级座位 |
| --- | --- |
| `0.1.5-rc.2` | `sidebar.brand.mark/name`、`sidebar.panellist`（list，**0 个占用者**）、`sidebar.workspaces`（single，被 WorkspaceBrowser 占用）、`sidebar.settings`、`sidebar.footer.action`（list）；另有 keyed `main` 面板 |
| `0.1.2-rc.1` | `sidebar.brand.mark/name`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.footer.action`（list）；**没有** `sidebar.panellist` / `main` |

`sidebar.footer.action` 是两个运行时的交集，`kind: 'list'` 且 additive（0.1.2 里 `ui-cordis` 就注册在它上面，注册形态 `{ name, id, locale, inject }`）。插件因此把面板放在这里，并用自绘对话框承载面板本体。

### 11.7 在进程内驱动一轮真实 agent turn（验收与冒烟用）

- web 组合进程内启动需要 launcher 事实：`provideCmdline(ctx, { args: ['--no-open','--port','0'], exit })`（`packages/boot/cmdline/src/index.ts:70-88`），否则 `web-startup` 行永远不会激活。
- 手工 `agents.create(...)` 的 agent **必须**自己装模型选择，否则装配 persona 时会以 `prompt variable "{{model}}" has no value` 失败（`installModelSelection`，`packages/core/agent/src/model-selection.ts:76-102`）。
- web 组合把模型可见的工具行放在 **agent preset realm** 里（`tool-fs` / `tool-bash` / `tool-fs-search` / `tool-jobs` 在 web-app 层被 `disabled: true`），未加入 preset 的 agent 解析工具时面对空层，会得到 `unknown tool "read"`；正确做法是照 `packages/api/session-controller/src/agent.ts:374-387` 在 `setup` 里 `agentPresets.mount(agentCtx, presetId)`。
- headless 组合没有 preset realm，工具在全局层，一次性 `dsh --profile headless "<task>"` 子进程即可驱动完整轮次；模型端点由 `DEEPSEEK_BASE_URL` 指向脚本化的 OpenAI 兼容服务（`packages/llm/llm-deepseek/src/index.ts:137,213,395`），无需凭据。
