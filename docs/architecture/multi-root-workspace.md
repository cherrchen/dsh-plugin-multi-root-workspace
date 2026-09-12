# 架构文档：Multi-root Workspace（不改上游：provider 替换 + 子类化）

> 状态：Target Architecture 设计稿（待评审；本文描述的是尚未实现的目标设计，不是当前已实现的系统事实）
> 硬约束：不修改上游仓库（deepseek-harness）任何包；产物是外部 bundle，经 `dsh plugin add` 或 profile patch 组合。
> 事实依据：[multi-root-workspace-research.md](../reference/multi-root-workspace-research.md)（§1-7 上游现状，§8 不改上游机制，§9 发布形态与运行时解析）；需求边界：[multi-root-workspace.md](../requirements/multi-root-workspace.md)；排期：[M1 计划](../plans/completed/2026-09-12-m1-composition-and-passthrough.md)
> 修订（2026-09-12）：按 M1 实现前探查收窄替换集合为两行并取消 `MultiRootBashExecutor`（§5.2），依据见 [ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md) 与 [ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)。

## 1. 总览

```text
                DSH Workspace（上游，不改）
                     │  workspace.path = Primary Root（canonical realpath）
                     │  session.header.cwd = Primary Root（不可变）
                     │
        ┌────────────┴───────────────────────────────────┐
        │ multi-root-workspace 外部 bundle（host+client） │
        │  root 注册表 / 校验 / UI / scope 解析            │
        └───────┬───────────────────────────────┬────────┘
                │ systemPrompt.context（拓扑快照） │ patch: disable 上游 2 行 + insert 2 provider 行 + 1 服务行
                ▼                               ▼
   ctx.systemPrompt（上游）    MultiRootFileSystem          MultiRootSandboxProvider
                              (extends LocalFileSystem)    (extends LocalSandboxProvider)
        Agent                     ctx.fs（多根 fence）         ctx.sandbox（附加根 grant）

    消费路径（消费方全部不改，只共享同一份 scope 解析与上游 sandboxPolicy）：
      fs 工具 ─────────────────────────────► ctx.fs
      bash 工具 ──► ctx.shell（上游 SandboxBashExecutor）──► ctx.sandbox
      terminal / PTY（上游）────────────────────────────────► ctx.sandbox
```

分工一句话：**插件管理"哪些目录属于这个 Workspace"，并用上游同款机制（内核 runner + 进程内 fence）把它们安全地放开**。上游不感知插件存在；未安装插件时一切如常。

## 2. 为什么必须是"替换 provider 行"（备选路径排除）

不改上游时，允许根的判定点全部在上游 provider 内部（`SandboxedFileSystem.checkedTarget`、`SandboxBashExecutor.confine` → `LocalSandboxProvider.confine` → 各方言 profile），且：

- `fs/write-intent` waterfall 只决定版本守卫，不触及 policy，fence 在其后（调研 §8.4）；
- `tools/pre-execute` 设计上禁止改写参数（调研 §8.4）；
- `SandboxExecutionPolicy.workspaceRoot` 单值，替换 `sandbox-policy` 或换 `runnerCommand` 都表达不了多根。

因此唯一语义正确的路径（调研 §8.6 路径 A）：**disable 上游 `fs-sandbox` 与 `sandbox` 两行，insert 插件自己的两个 provider 子类**（外加一个插件自有 scope 服务行）。替换集合的取舍见 [ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)：bash 与 PTY 的全部 confinement 都经 `ctx.sandbox.confine` 表达（见 §5.2），因此 `bash-sandbox` 无需替换。上游的所有 Consumer（`tool-fs`、`tool-bash`、`terminal-bash`、approval 链）不改一行——它们依赖的只是 Service Definition 接口，而那是最稳定的缝。

被否决的方案：`fs/*` 事件放行（不可行）、`tools/pre-execute` 改写（不可行）、danger-full-access（禁止）、自带完整 provider（`extends FileSystem`，保留为长期形态，见 §8）。

## 3. bundle 结构与组合方式

```text
dsh-plugin-multi-root-workspace/
  package.json            # dsh.bundle.patch: "./cordis.patch.yml"（M3 再加 dsh.client 声明）
  cordis.patch.yml
  src/                    # host 半部（见 §4、§5）
  client/                 # client 半部（见 §7，M3 落地）
```

`cordis.patch.yml`（示例，id 命名实现期定）：

```yaml
- id: fs-sandbox          # 上游行 id（base patch :479）
  disabled: true
- id: sandbox             # 上游行 id（base patch :205）
  disabled: true
- insert:
  - id: multi-root-fs
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
    inject: [sandboxPolicy, multiRootScope]
  - id: multi-root-sandbox
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
    inject: [sandboxPolicy, multiRootScope]
  - id: multi-root-scope
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/scope'
  - id: multi-root-command
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
    inject: [commands, multiRootScope, workspaceRegistry]   # M3
```

要点：上游 `sandbox-policy`、`bash-sandbox`、`tool-fs`、`tool-bash`、`terminal-bash` 行**全部不动**——它们继续向 `ctx.fs`/`ctx.shell`/`ctx.sandbox` 要能力。同 key 重复 provide 会抛错（调研 §8.2），所以 disable 必须先于 insert 生效（同一 patch 文档内顺序保证；并在插件 apply 期断言 `ctx.fs`/`ctx.sandbox` 是自己的实例，否则 fail loud）。`inject` 既可写在 patch 行上（patch 的任意键都会覆盖目标行），也可由子类的 `static inject` 提供——实现期二选一，不重复声明。

## 4. Scope 解析（插件的单一权限世界）

```ts
// 多根语义在插件内的唯一 home（对应上游 roots.ts 的角色）
export interface FilesystemScope {
  primaryRoot: string          // = session.header.cwd canonical（沿用上游 resolve 结果）
  additionalRoots: readonly string[]   // canonical、去重、≠primary、可为空
}

class MultiRootScopeService extends Service {         // ctx.multiRootScope
  /** 每次受限调用解析一次；无 session 时空根。 */
  resolve(request: { session?: Session }): FilesystemScope
  /** 供其他 workspace-scoped 插件查询（需求 §19 的代位）。 */
  scopeOf(primaryRoot: string): readonly AdditionalWorkspaceRoot[]
}
```

- **数据源**：`dsh-storage-domain` 插件命名空间 KvTable，key = workspaceId；记录 `AdditionalWorkspaceRoot { id: Branded<'AdditionalRootId'>, path, alias?, addedAt }`。不存 primaryRoot（WorkspaceRegistry 拥有）。
- **解析链**：`session.header.cwd` → `realpathSync.native` → workspaceId（或直接以 canonical 主根为 key 查根表）→ 附加根集合（激活时 re-check 存在性，缺根按 config 跳过并通知）。
- **为什么用插件存储而不是 session 事件**：out-of-tree 插件 append 自有事件类型会给会话日志引入"未装插件的 dsh 拒绝打开"风险（session-format 的 required-on-read 规则，除非信封 `ignorable: true`）；存储按不可变的 header cwd 索引，fork/resume/重启行为同样确定。模型可见性由 §6 的 context 快照落 log 满足。
- **空根直通**：`additionalRoots.length === 0` 时，两个 provider 都走与上游等价的代码路径（sandbox provider 逐元素返回上游 `confine` 的结果；fs provider 的 containment 语义与上游 `SandboxedFileSystem` 逐项一致，由差分测试钉住）——验收标准 2。

两个 provider 一律从 `MultiRootScopeService.resolve()` 取根，**不允许任何一个 provider 自行判断路径**（需求 §13）。scope 服务在 M1 即落地（数据源为空表），M2 只把数据源换成附加根集合，provider 结构不变。

## 5. 两个 Provider 子类（外加一个 scope 服务）

### 5.1 `MultiRootFileSystem` — 提供 `ctx.fs`（进程内 fence，全平台）

- `extends LocalFileSystem`（不 extends `SandboxedFileSystem`：其 `checkedTarget` 是 TS-private，跨包子类不能类型安全地复用或覆盖）。
- 保留上游 `SandboxedFileSystem` 的对外行为：`sandboxMode` getter（供 `tool-fs` 的 `FsSandboxController` / escalation UI 使用）、`FS_SANDBOX_DENIED` 错误语义与升级指引文案。
- `writeText` / `editText`：解析 scope → `read-only` 全拒、`workspace-write` 对 `[primaryRoot, ...additionalRoots, /tmp, tmpdir()]` 逐个 containment 判定、`danger-full-access` 放行。写路径本体（原子写、edit 临界区、锁）调用上游 `LocalFileSystem` 实现——**不重写 IO**。
- containment 判定使用插件内的本地实现，并在文件头注明来源 commit 与复制范围：上游 `isPathUnder` 只存在于 `@deepseek-ai/dsh-fs-sandbox/src/containment.ts`，而发布包不含 `src/`（见 [ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)），深导入在安装形态下必然失败；等价性由差分 parity 测试钉住（§6）。
- 多根 denial 文案列出全部允许根；escalation 沿用上游 API（只放宽 mode，不放宽根）。

### 5.2 为什么不替换 `bash-sandbox`（原 `MultiRootBashExecutor` 已取消）

bash 与 PTY 都**不掌握根集合**，它们的 confinement 全部委托给 `ctx.sandbox`：

- `SandboxBashExecutor.confine` 只做 `this.ctx.sandbox.confine(['bash','-c',command], policy)`（`packages/shell/bash-sandbox/src/index.ts` 约 177-179 行）。
- PTY 同理：`dsh-terminal-bash` 取 `ctx.get('sandbox').confine(argv, policy)` 作为 spawn argv（`packages/terminal/terminal-bash/src/index.ts` 约 105-108 行），cwd 用 `policy.workspaceRoot`。
- `SandboxPolicy` 只有单值 `workspaceRoot`；`SandboxBashExecutor.resolve` 仅补 `sandboxPolicy: request.sandboxPolicy ?? ctx.sandboxPolicy.resolve()`。

因此多根 grant 只需在 §5.3 一处表达，bash 与 PTY 自动获得多根能力，且不需要任何专属代码。另起一个 bash 执行器只会把上游的 mode / escalation / process-facts 语义复制一份并长期对齐。取舍与备选方案见 [ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md)。

代价（已知并接受）：`policy.workspaceRoot`（= 主根）继续决定 bash 的默认 workdir 与 PTY 的默认 cwd，符合"不改 Session cwd 语义"；"以附加根作为默认工作目录"不在第一期范围。

### 5.3 `MultiRootSandboxProvider` — 提供 `ctx.sandbox`（内核方言，同时覆盖 bash 工具与 terminal/PTY）

- `extends LocalSandboxProvider`（`confine(argv, policy)` 是 public，可直接扩展；`internals` public）。
- override `confine`：先 `super.confine(argv, policy)` 得到上游单根 argv/profile，再按方言**追加**附加根 grant：
  - **Seatbelt (darwin)**：向 profile 字符串追加 `(allow file-write* (subpath "<root>"))` 形式（每附加根一条）。
  - **bwrap (linux)**：在 runner argv 的 `--` 分隔符前为每个附加根插入等价的可写 bind 参数（与上游临时 `/tmp` mount 的既有差异保持一致）。
  - **Landlock (linux)**：为每个附加根追加与上游同形的 launcher rw flag。
  - **Windows ACL**：第一期不扩展（fs fence 已覆盖 Windows 写路径；pwsh 内核级多根列入后续阶段），`confine` 在 win32 上保持 super 行为并输出一次显式告警，文档明示限制。
- 方言实现不调用上游 builder（`dsh-sandbox-local/src/profiles.ts` 在发布形态下不可达），改为从 `super.confine` 的输出中识别并克隆 grant 模板；识别失败时抛错，绝不静默退回单根（见 [ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)）。
- 三条不变量：空附加根时**逐元素**返回 super 的结果；`enforcement` / `denialSignatures` / `runnerFailureRules` 原样透传（否则 bash 的 denial / enforcement 上报会失真）；只有 `argv` 可以变化。

### 5.4 上游 `sandbox-policy` 行不动

`SandboxPolicyService.resolve()` 继续提供 mode 与主根（含 `sandbox/mode` 覆盖、escalation、fallback 语义）。两个子类在其结果上**增广**附加根。mode 语义、`read-only` 全禁、approval、`sandbox/mode` 切换全部继承上游。

## 6. Agent 认知与单一权限世界

- **拓扑注入**：插件注册自己的 `ctx.systemPrompt.context({ name: 'multi-root:scope', ... })`，workspace-write 且有附加根时输出稳定拓扑（只列根，不列文件，满足需求 §8）；快照随请求落 model history（上游 `sandbox:policy` 同机制），满足 model-visible ⟺ logged。空根时不输出任何内容（不影响 prompt cache 与既有快照）。
- **单一权限世界**：fs fence 与内核方言（sandbox provider）消费 §4 的同一份 `FilesystemScope`；bash 与 terminal/PTY 通过 `ctx.sandbox` 间接消费同一份，因此它们的根集合与 fs fence **由构造相同**。插件自带 **parity 测试**——同一 scope 下，进程内 fence 与三种内核方言对"根内/根间外/临时区"的允许矩阵一致（接替上游 `writableRoots()` 测试的角色）。

## 7. Root 管理与 UI（与上游约束无关，全部走公开 API）

- **校验规则**（`resolve(request): Spec` 显式步骤，fail loud）：输入存在且是目录 → `canonicalPath` → 判重（duplicate / ==primary 默认拒绝 / nested 默认允许并记录）→ 入库；启动与每次播种前 re-check 存在性，缺根按 config 跳过 + 用户可见通知。
- **命令** `/workspace-folders`（list/add/remove/alias/reveal）：`ctx.commands.register`；add 经 `directoryPicker.pick`（Typert 远程命名空间，桌面原生对话框 / 浏览器内浏览）。
- **可选内省工具** `workspace_roots`：零参数只读；先验证 §6 拓扑文案是否已满足 Agent 认知，够用则不做（需求 §9 预留删除条件）。
- **Client 半部**：`ctx.slots.inject` 挂进 `ui-workspace` 既有结构，Folders 面板（主根/附加根标记、Add/Remove/Reveal/Copy Path/Alias）；占据 `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` picker 洞；文案走 `ctx.locale.register(ns, { zh, en })`。桌面端（apps/desktop）与 web 共用 client graph，零专属代码。
- **远程通道**：插件新增自己的 Typert 命名空间（如 `multiRootWorkspace`）承载 UI ↔ host 的 CRUD；不直读其他插件存储。

## 8. 演进形态

- **当前（路径 A）**：替换两行 + 子类（外加一个自有 scope 服务行）。风险集中在上游 pre-stable 升级。
- **升级韧性**：插件 `package.json` 精确 pin dsh 版本（`latest` dist-tag 指向陈旧版本，范围依赖会解析到错误版本，见调研 §9）；仓库 CI 加"升级 smoke"——改 pin 后跑差分 parity + 组合 dump 断言 + 空根行为用例（空根直通 + 多根写入 + 根外拒绝），差异即报警；子类只依赖公开方法面（禁止 `#` 假设、禁止原型替换）；**只允许包入口导入**，不引用任何 `pkg/src/*` 路径（发布包不含 `src/`）。完整策略见 [ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)。
- **长期（路径 D / 上游 seam）**：若上游未来接受通用 Filesystem Scope Seam（`ctx.filesystemScope` contributor + `writableRoots()` 数组化 + 方言数组化，见 §9），插件撤销两个替换行，provider 子类退化为薄 scope contributor；`FilesystemScope` 接口即按该 seam 的目标形态设计，迁移是删除而非重写。

## 9. 附录：可改上游时的理想 seam（备忘）

若约束解除，向上游提交的 PR 栈为：① `SandboxExecutionPolicy.additionalRoots` + `writableRoots()` 数组化（`packages/sandbox/sandbox/src/roots.ts`，语义唯一 home）；② `ctx.filesystemScope` contributor seam（新包 `packages/fs/fs-scope`，含 `workspace/scope` log-only 事件 + projection，照 `sandbox/mode` 模板）；③ `SandboxPolicyService.resolve` 合并 + `renderPolicyContext` 拓扑句；④ fs fence any-of-roots + bwrap/Landlock/ACL 方言数组化；⑤ `renderPolicyContext` 空根字节级不变。届时本插件仅保留 root 注册表与 UI，两行替换撤销。此附录保留本设计文档的完整性，当前不执行。

## 10. 被否决的方案（本约束下）

| 方案 | 否决理由 |
|---|---|
| `fs/write-intent` 等事件"放行" | single-slot decision 只决定版本守卫，不触及 policy；fence 在 provider 内部之后（调研 §8.4） |
| `tools/pre-execute` 改写 path/policy | 设计上禁止 input rewriting；`FsSandboxController` 无事件口子（调研 §8.4） |
| 替换 `sandbox-policy` 表达多根 | `workspaceRoot` 单值，所有消费方只读它 |
| danger-full-access + 提示词约束 | 需求 §10/§20 禁止 |
| 替换 `bash-sandbox`（原 `MultiRootBashExecutor`） | bash 与 PTY 的 confinement 全部经 `ctx.sandbox`，执行器不掌握根集合；替换只会复制上游 mode/escalation/process-facts 语义（见 §5.2、ADR-0001） |
| `extends LocalFileSystem` 后"直通 super"实现空根直通 | `LocalFileSystem` 本身没有 fence，直通会**丢掉** containment，不是"与上游一致"；空根直通必须以行为等价（差分测试）定义 |
| 委托实例化上游 `SandboxedFileSystem` 复用其 fence | 需要脱离当前上下文构造该服务（service 注册副作用），并让两套生命周期并存；收益仅限 M1，M2 仍需自建多根 fence |
| 深导入上游 `pkg/src/*` 复用 `isPathUnder` 与方言 builder | 发布 tarball 不含 `src/`（调研 §9），安装形态下必然失败；本机可解析只是符号链接造成的假象 |
| 自带完整 fs/bash provider（路径 D） | 当前成本最高（重做 IO 临界区），保留为升级韧性耗尽后的长期形态 |
| 自有 session 事件承载 scope | 未装插件的 dsh 会拒绝打开含未知事件类型的日志（required-on-read）；第一期用插件存储 + canonical cwd 索引替代 |
