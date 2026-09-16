# 架构文档：Multi-root Workspace（不改上游：provider 替换 + 子类化）

> 状态：**§4、§5.1、§5.3、§6、§7 均已实现（M1/M2/M3，随 `v0.1.0` 发版）；§3 的 `multi-root-compat` 门禁、§6.1 的附加根指令行、§7 的跨进程 Authority Lease 与 host 推导的面板权威属 `v0.1.1` 硬化批次（H1–H4），已实现但尚未发版**。进度、编号与发布状态的唯一真源是[路线图 §进度总账](../plans/active/2026-09-12-multi-root-workspace.md#进度总账)；已实现部分可按当前仓库代码与各 completed 计划中的实施结果验证；§8 的长期演进形态、§9 的上游 seam 附录仍是设计。
> 硬约束：不修改上游仓库（deepseek-harness）任何包；产物是外部 bundle，经 `dsh plugin add` 或 profile patch 组合。
> 事实依据：[multi-root-workspace-research.md](../reference/multi-root-workspace-research.md)（§1-7 上游现状，§8 不改上游机制，§9 发布形态与运行时解析，§10 方言形状与子类可用面）；需求边界：[multi-root-workspace.md](../requirements/multi-root-workspace.md)；排期：[M1 计划](../plans/completed/2026-09-12-m1-composition-and-passthrough.md)、[M2 计划](../plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)
> 修订（2026-09-12）：按 M1 实现前探查收窄替换集合为两行并取消 `MultiRootBashExecutor`（§5.2），依据见 [ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md) 与 [ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)；M2 实施后 §5.3 与 §6 改写为已实现的机制（[ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md)）；M3 实施后 §7 改写为已实现的机制（[ADR-0004](../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[ADR-0005](../decisions/ADR-0005-out-of-tree-client-transport.md)）。2026-09-15：§7 增加 store-wide Registry Authority Lease（[ADR-0007](../decisions/ADR-0007-registry-authority-lease.md)）；面板主根改为 host session 推导（[ADR-0008](../decisions/ADR-0008-panel-session-derived-authority.md)）；§3 增加 `multi-root-compat` 启动门禁与 §6.1 附加根指令行（[ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)、[ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)）。

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
                │ systemPrompt.context（拓扑快照） │ patch: disable 上游 2 行 + insert 门禁/provider/服务/指令/命令各行
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
  - id: multi-root-compat                                  # 已实现；启动门禁，见 ADR-0009
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/compat'
  - id: multi-root-fs
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
    inject: [multiRootCompat, sandboxPolicy, multiRootScope]
  - id: multi-root-sandbox
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
    inject: [multiRootCompat, sandboxPolicy, multiRootScope]
  - id: multi-root-scope
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/scope'
  - id: multi-root-registry                                # 已实现（M3）；lease 见 ADR-0007
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/registry'
    config:
      leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
  - id: multi-root-instructions                            # 已实现；附加根顶层与工作过的子目录的 AGENTS.md，见 §6.1
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/instructions'
    config:
      maxBytes: 65536
  - id: multi-root-command                                 # 已实现（M3）
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
```

`multi-root-compat` 是第一行，而且是**启动门禁而不只是诊断服务**：四个安全相关的行（`multi-root-fs`、`multi-root-sandbox`、`multi-root-registry`、`multi-root-instructions`）都 inject `multiRootCompat`，而 cordis 不会启动 injected service 缺失的行。所以当宿主的 DSH 版本不在精确 allowlist 上（或多个 `@deepseek-ai/dsh-*` 混装）时，这四行**根本不启动**，组合退化成"未安装本插件"，而不是"围栏可疑"。理由与判定顺序见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。

要点：上游 `sandbox-policy`、`bash-sandbox`、`tool-fs`、`tool-bash`、`terminal-bash` 行**全部不动**——它们继续向 `ctx.fs`/`ctx.shell`/`ctx.sandbox` 要能力。同 key 重复 provide 会抛错（调研 §8.2），所以 disable 必须先于 insert 生效（同一 patch 文档内顺序保证；并在插件 apply 期断言 `ctx.fs`/`ctx.sandbox` 是自己的实例，否则 fail loud）。`inject` 既可写在 patch 行上（patch 的任意键都会覆盖目标行），也可由子类的 `static inject` 提供——实现期二选一，不重复声明。

## 4. Scope 解析（插件的单一权限世界）

```ts
// 多根语义在插件内的唯一 home（对应上游 roots.ts 的角色）——已实现的公开面
export interface FilesystemScope {
  primaryRoot: string          // = policy.workspaceRoot canonical（上游 resolve 的结果）
  additionalRoots: readonly string[]   // canonical、去重、≠primary、可为空
}

class MultiRootScopeService extends Service {         // ctx.multiRootScope
  /** 每次受限调用解析一次。 */
  resolve(policy: SandboxExecutionPolicy): FilesystemScope
  /** 某一 canonical 主根已登记的附加根（需求 §19 的代位）。 */
  scopeOf(primaryRoot: string): readonly string[]
  /** 登记表写入口：M2 由测试与冒烟注入，M3 由插件存储喂养。 */
  setAdditionalRoots(primaryRoot: string, roots: readonly AdditionalWorkspaceRoot[]): void
}
```

- **数据源（已实现）**：§7 的注册表（`dsh-storage-domain` domain `multi_root_workspace`，键 = canonical 主根，记录 `RegisteredRoot { id, path, recordedPath?, alias?, addedAt }`）在每次变更后调用 `setAdditionalRoots(root, roots)`；该方法仍是 scope 的公开写口，测试与冒烟脚本可直接使用。provider 结构不随数据源改变——它们只经 `resolve()` / `scopeOf()` 取根。
- **解析链**：`policy.workspaceRoot` → `canonicalPath`（= `realpathSync.native`）→ 登记表查找 → `sanitizeAdditionalRoots`（canonical 化、去重、剔除等于主根的项、**剔除解析结果已不等于登记时授予目录的项**、保持登记顺序）。存在性与重定向判定都在注册表侧完成：`available` 才进入登记表，`missing` / `redirected` / `invalid` 保留但不授予（ADR-0004）。
- **授权前提（安全相关）**：登记项携带 `recordedPath`（登记当时观察到的 canonical 目录），scope 只在 `canonicalPath(path) === recordedPath` 时授予。`canonicalPath` 是 `realpath`，因此"目录被替换成符号链接"会让解析结果变到另一个目录；把重新解析当成重新授权就等于把写权限交给任何能改本机文件系统的人。scope 侧也会独立做这个判断（不假设调用者已经判过）。
- **为什么用插件存储而不是 session 事件**：out-of-tree 插件 append 自有事件类型会给会话日志引入"未装插件的 dsh 拒绝打开"风险（session-format 的 required-on-read 规则，除非信封 `ignorable: true`）；存储按不可变的 header cwd 索引，fork/resume/重启行为同样确定。模型可见性由 §6 的 context 快照落 log 满足。
- **空根直通**：`additionalRoots.length === 0` 时，两个 provider 都走与上游等价的代码路径（sandbox provider 逐元素返回上游 `confine` 的结果；fs provider 的 containment 语义与上游 `SandboxedFileSystem` 逐项一致，由差分测试钉住）——验收标准 2。

两个 provider 一律从 `MultiRootScopeService.resolve()` 取根，**不允许任何一个 provider 自行判断路径**（需求 §13）。

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

- `extends LocalSandboxProvider`。上游发布形态的公开面只有 `confine(argv, policy)` 与测试钩子 `internals`（`runnerArgv` / `landlockLauncher` / `seatbeltExec` 均为 TS-private，见调研 §10.1），因此实现方式是从 `super.confine` 的**输出**识别方言并克隆 grant 模板（[ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md)）。
- `override confine(argv, policy)` 的决策顺序（已实现）：
  1. 先 `super.confine(argv, policy)`：上游结果是 argv 与三个 fact 的唯一来源；
  2. `ctx.multiRootScope.resolve(policy)`；**非 `workspace-write` 或附加根为空 ⇒ 原样返回上游结果**（`read-only` 不授予任何附加根；`danger-full-access` 下 bash 与 PTY 根本不调用 `confine`，见调研 §10.4）；
  3. 校验 `[...profileArgs, '--', ...callerArgv]` 结构，按结构标记识别方言（seatbelt `[…, -p, <SBPL>]` / windows-acl `--mode` / landlock `--rw` / bwrap `--ro-bind`）；
  4. 按方言克隆观测到的 grant 拼写并追加附加根：
     - **Seatbelt (darwin)**：在既有的 `(allow file-write* (subpath …))` allow form 内追加 `(subpath "…")`（字面量转义与上游 `sbplString` 同实现）。
     - **bwrap (linux，含 `runnerCommand` 配置情形)**：从 `<workspaceRoot>` 的 bind 三元组克隆 flag，在分隔符前追加 `[flag, root, root]`。
     - **Landlock (linux)**：取 `<workspaceRoot>` 前一位的 rw flag，追加 `[flag, root]`。
     - **已授予即跳过**：语言方已授予同一路径时不再重复授予（与 fs fence 的去重一致，并避免 bwrap 上真实 `/tmp` 覆盖 `--tmpfs /tmp`）。
     - **Windows ACL**：第一期不扩展（argv 里没有可追加的路径，授权按 workspace SID 进行），保持上游 wrap 并输出**一次**显式告警；fs fence 仍覆盖 Windows 写路径。
  5. 识别或克隆失败 ⇒ 抛 `SandboxUnavailableError`（fail closed），绝不退化为"只授予主根"的静默执行。
- 三条不变量：空附加根或非 `workspace-write` 时**逐元素**返回 super 的结果；`enforcement` / `denialSignatures` / `runnerFailureRules` 原样透传（否则 bash 的 denial / enforcement 上报会失真）；只有 `argv` 可以变化。
- **调用形状跨版本保形**：上游 `confine` 在不同受支持版本上分别是同步与异步的，因此整个覆盖走 `src/compat/sandbox-confine.ts` 的 `widenConfined()`：上游同步就同步返回，上游返回 promise 就返回 promise。绝不统一包成 promise——那会把 `ctx.sandbox.confine()` 对组合里每一个既有调用方（bash executor、PTY backend）变成 thenable，等于插件自己引入一次破坏性变更。见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md) 第 4 条。

### 5.4 上游 `sandbox-policy` 行不动

`SandboxPolicyService.resolve()` 继续提供 mode 与主根（含 `sandbox/mode` 覆盖、escalation、fallback 语义）。两个子类在其结果上**增广**附加根。mode 语义、`read-only` 全禁、approval、`sandbox/mode` 切换全部继承上游。

## 6. Agent 认知与单一权限世界

- **拓扑注入（已实现）**：`MultiRootScopeService` 注册 `ctx.systemPrompt.context({ name: 'multi-root:scope', order: getContextOrder('SANDBOX_POLICY') + 1, … })`：workspace-write 且有附加根时输出一段稳定拓扑（只列根，不列文件，满足需求 §8），其中声明附加根属于同一 workspace 且 session cwd 不变；空根、`read-only`、以及没有 agent 的诊断装配下都不输出任何内容（空段被 `renderContextSections` 过滤，快照与未装插件逐字节相同）。注册是软依赖：宿主没有 `systemPrompt` seam 时不贡献拓扑也不报错。快照随请求落 model history（上游 `sandbox:policy` 同机制），满足 model-visible ⟺ logged。
- **单一权限世界（已实现）**：fs fence 与内核方言（sandbox provider）消费 §4 的同一份 `FilesystemScope`；bash 与 terminal/PTY 通过 `ctx.sandbox` 间接消费同一份，因此它们的根集合与 fs fence **由构造相同**。插件自带 **parity 矩阵测试**（接替上游 `writableRoots()` 测试的角色）：同一 scope 下，对「主根内 / 主根嵌套 / 附加根内 / 附加根嵌套 / 根外 / 共享词法前缀的兄弟目录 / 经附加根内符号链接逃逸 / 平台临时区」逐类比较 fs fence 的真实写判定与各方言 argv 的授予集合，并在两端模式（workspace-write / read-only）各跑一轮；解析 argv 的代码由测试侧独立实现。宿主能真正执行 runner 时（Linux CI 的 bwrap/Landlock、macOS 的 Seatbelt）另加真实受限执行用例，不能执行时显式 skip 并说明原因。
- 已知不对称（上游既有，非插件引入）：bwrap 与 Landlock 只授予字面 `/tmp`，不授予 `tmpdir()`（调研 §10.3），因此 parity 断言的语义限定为「附加根集合与模式」；Windows 上内核级多根缺失，fs 可写而 bash 不可写（第一期已知限制）。

### 6.1 附加根自己的指令文件（`multi-root-instructions`，已实现）

上游 `agent-instructions` 是从 session cwd **向上走**发现指令文件（外加一个 user-global 文件）。在多根工作区里这条上行路径永远到不了附加根，于是 `repo-b/AGENTS.md` 对一个**被允许写 `repo-b`** 的模型是不可见的；同理，`repo-b/src/AGENTS.md` 对一个刚在那个目录里读过文件的模型也不可见。`multi-root-instructions` 只补这一个缺口；主根（含其 nested 文件）的链条与 user-global 文件仍然是上游的事。

三个刻意选择：

1. **不是 system prompt 贡献**。指令文本是 producer-supplied context，不是 system authority，因此以 user-role 消息进入，标注 `{ kind: 'plugin', plugin: '@dsh-electron/dsh-plugin-multi-root-workspace', form: 'instructions' }` —— 这正是 DSH 自己的 message model 为它保留的位置。它也是唯一被记录的通道，而 model-visible 的内容必须被记录。
2. **从 `agent/pre-step` 注入，而不是 session 生命周期事件**。`pre-step` 是 awaited waterfall，所以发现、读取、渲染都在它所服务的那一步**之前**确定性完成（含第一步）。同步的 prompt 回调无法 await，emit 模式的生命周期监听会与第一步竞争。它也是各受支持版本里形状完全一致的那个钩子，从而把这个特性挡在兼容矩阵之外。
3. **发现被钉在根上**。`projectRoot` 始终是该附加根（上行走到根为止），`cwd` 是本次被考察的那个目录；随后每个候选还必须 canonical 地**位于**该根内部。这就是把 `$DSH_HOME/AGENTS.md`、主根（含其 nested 文件）、以及任何祖先目录的文件挡在外面的机制——它们不会被本插件重复注入一遍。

其余机制：被考察目录恰好三类——**根自身**（每一步都看，顶层文件的变化与消失因此总会被察觉）、**已投递 nested 文件所在目录**（不需要新触碰就能察觉变化与消失，与上游 reconcile 的语义一致）、以及本会话**成功**的 `read` / `write` / `edit` 触碰路径的父目录**及其每个祖先目录（直到该附加根）**——中间目录的 `AGENTS.md` 因此才可见：上游 discovery 会上报它的候选，但精确目录过滤只保留被走查目录自身的候选，所以每个中间目录必须自己成为一次考察的起点。触碰取自持久化的 `session/event`：`tool/call` 与其 `tool/result` 按 call id 配对，失败的调用从不使目录变得相关；因此本行不依赖 tool 层的包，也不使用 0.1.6 才有的 `SessionMessageProjection`。`maxBytes`（默认 65536，与上游指令行的默认预算一致）约束的是**整个附加根快照**，而不是每个根各一份预算，否则十个根会悄悄吃掉十倍 context；各根按 scope 顺序消耗，同一个根内部按「浅 → 深」渲染、同目录内保持 discovery 顺序，撤销与撤回文案不占预算。投递状态按 session、按 `(根, 相对目录, 文件名)` 记录**文件内容**的 SHA-256：内容不变不再发送，内容变化只重发那一个文件；已投递但在考察中消失的文件会被撤回（目录走查失败、或候选被体积/读取过滤掉，都不算消失）。根一旦离开 scope（移除 / 消失 / 被替换即 `redirected`），生成**显式撤销**文本——历史对话里原来的指令仍然存在，沉默不等于撤回。渲染经 `src/compat/agent-instructions.ts` 的 `renderInstructions(...)` 调用上游渲染器（该包在不同版本里改过导出名，且是 optional peer：不存在时本行贡献为空）；复用上游的**语义**，不复用它的非公开 helper。消息构造走 `src/compat/llm-message.ts` 的 `createInstructionMessage(...)`（`{ kind: 'plugin', form: 'instructions' }` 那条 user 消息）：`@deepseek-ai/dsh-llm` 是 **optional peer**，只在该构造点按需 `import`；业务层经 `src/index.ts` barrel 被 `multi-root-instructions` 行装载，静态值导入会让缺少该 peer 的组合连装载都失败。零附加根时该行一条消息都不注入，resume 语义与状态边界见 [ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)。

**边界**：主根（含子目录）的 nested 发现仍归上游 `agent-instructions`；本行只认 `read` / `write` / `edit` 三个工具名且只认成功的调用（`str_replace_editor` 一类不算）；投递状态是进程内的，不跨进程、不跨 resume。范围、备选方案与后果见 [ADR-0010](../decisions/ADR-0010-additional-root-instruction-scope.md)。

## 7. Root 管理与 UI（已实现，M3）

三行插件行之外新增两行：`multi-root-registry`（服务）与 `multi-root-command`（用户表面）。前者把注册表喂给 §4 的 scope，后者把命令与面板接到注册表上；两个 provider 完全不知道它们存在。

- **注册表（`MultiRootRegistry`，`ctx.multiRootRegistry`）**：`dsh-storage-domain` 的 domain `multi_root_workspace`（version 1，`single` layout，单表 `roots`），**键 = canonical 主根**，值 = 有序记录 `{ id, path, recordedPath?, alias?, addedAt }`（可选仅为兼容旧数据，新登记必填）。`[Service.init]` 先拿 store-wide 内核 lease，成功后才打开 domain、用与写入相同的规则重新判定、只把可用的根播种进 `ctx.multiRootScope`。每次变更先落盘再改内存，成功后重播种 scope 并通知监听者；**同一主根的所有变更在一条 Promise 队列里整体串行**（读快照 → 校验 → 落盘），因为存储域只串行化单个写入，覆盖不到读—改—写。JSON backend 打开后内存 authoritative、没有跨进程 CAS，因此 **同一时刻只允许一个 Registry Authority Process** 打开这份介质（POSIX `flock` / Windows named semaphore，进程死亡由 kernel 释放）；争用进程 fail-closed：scope 为空、mutation 抛 `registry-contended`、`refresh()` 可重新竞选。存储整体打不开时降级为"没有附加根 + 所有写操作抛 `storage-unavailable`"，不阻断 harness 启动。拆除顺序是**排空在飞 mutation → close domain → release lease**：整段拆除在 authority 转场队列里执行、与 acquisition 不交错，所以继任者绝不会打开一份缺了本进程最后一次写的快照。取舍见 [ADR-0004](../decisions/ADR-0004-root-registry-persistence-and-validation.md) 与 [ADR-0007](../decisions/ADR-0007-registry-authority-lease.md)。
- **读路径的重新校验（`refresh`）**：`registry.refresh(primaryRoot)` 先 `ensureAuthority()`（争用方可在对方退出后接管并**从磁盘重新 open**），再重新 `stat`、重新解析、重新裁决、重播种 scope 并通知监听者，**不写存储**；命令 `list` 与面板 `list` 端点都先走它，所以"列出来的范围"永远等于"此刻授予的范围"（目录消失 → `missing` 且撤销；目录回来 → 恢复授予；目录被替换 → `redirected` 且撤销）。`publish` 只在授予集合或不可用集合变化时才真正动 scope，因此刷新可以随时执行而不产生抖动。`recheck` = refresh + 落盘一次。
- **所有变更按具体记录**：命令和面板把列表行捕获为 `{ ordinal, id, path, addedAt }` entry ref，注册表在串行队列内重新核验后才执行 remove/alias/move。重复 id 不再会误删、批量改名或让排序隐式丢记录；无法唯一区分时明确拒绝。
- **scope 实时撤销**：每次 `scopeOf`/`resolve` 除了比对 `recordedPath`，还当场确认路径存在且是目录。即使尚未调用 registry `refresh`，删除的根也不会进入 fs/内核 grant，更不会被写入重建。
- **校验（`src/roots.ts` 纯函数，fail loud）**：`~` 展开（只限前导 `~`）→ 必须绝对 → 必须存在且是目录 → `canonicalPath` → 不等于主根 → **不与主根互相包含（`primary-overlap`，双向）** → 不与其他根重复 → 不与任何根互相包含（`nested` 双向拒绝）。失败返回稳定 code（`not-absolute` / `missing` / `not-a-directory` / `equals-primary` / `primary-overlap` / `duplicate` / `nested` / `invalid-alias` / `not-found` / `invalid-ref` / `storage-unavailable` / `registry-contended` / `reveal-unavailable` / `session-not-found`），三类表面（命令、面板、内部 API）共用同一词汇。存储读取侧用同一套规则（`classifyStoredRoots`），并额外判定 `recordedPath` 变化（`redirected`）与重复 id（全部 `invalid`）。
- **命令 `/workspace-folders`**：`ctx.commands.register`，语法 `list | add [path] | remove <n|path> | alias <n|path> [name] | reveal <n|path> | help`。无路径的 `add` 软注入 `directoryPicker`，capability 为 `native` 时直接 `pick(signal)`；`browse` 或 seam 缺失时返回明确错误（提示改用面板或传路径）。输出是英文文本（host 侧没有活动语言信息，见需求文档第一期限制）。
- **Client 半部**：`sidebar.footer.action`（list/root，两个受支持版本都提供的 slot）+ 自绘对话框；`ctx.locale.register('multiRootWorkspace', { zh, en })` 双语。每个工作目录行是两行显示：第一行主文字为显示名（主根 = 宿主 workspace 的上游标题，见 `primaryName`；附属根 = 登记的 alias，缺省为目录名），第二行次要文字为绝对路径。动作：复制路径 / 在文件管理器中显示 / 上移 / 下移为图标按钮，别名编辑与移除收进行内 `…` 菜单（ui-primitives `Menu`），底部"添加目录"为仅图标按钮、整行控件高度统一 32px。Add（`ctx.uiWorkspace.pickDirectory()`，退化为手输路径）。文案按 host 返回的 code 本地化。落点与通道的取舍见 [ADR-0005](../decisions/ADR-0005-out-of-tree-client-transport.md)；样式与 ui-primitives 展示型组件的 import 边界见 [ADR-0006](../decisions/ADR-0006-client-ui-host-tokens.md)。
- **主根显示名（`primaryName`）**：`RootsView` 的可选字段。面板分发时通过**可选兄弟服务查找**（同 `sessions`/`subprocess` 的模式，不进 `inject` 声明）读宿主 `workspaceRegistry`：先按会话成员关系（`list().find(w => w.sessionIds.includes(sessionId))`），未命中再 `resolveByPath(primaryRoot)`，命中即把 workspace 的 `title` 填进每个 `RootsView` 应答；查找失败只降级为"不填"，面板回退显示路径 basename，绝不因此报错。
- **通道**：插件自有 Connection RPC channel `/multi-root-workspace`（`connection.rpc.handle` / `connection.rpc.call`），端点为 `list` / `add` / `remove` / `alias` / `move` / `reveal`，返回 `{ ok, value } | { ok, error: { code, message, details } }`。**每个端点的应答形状是显式契约**（`src/contract.ts` 的 `PanelResponseMap`）：`reveal` 返回 `{ revealed }`，其余返回完整 `RootsView`；请求体与应答都在两端做运行时校验（`zod`，与存储 schema 同源），非法请求返回 `panel/bad-request`，形状不符的应答在面板侧变成一条本地化错误而不是渲染崩溃或静默误解。**主根权威是 host-derived**：`PanelRequest.sessionId` 必填，host 唯一通过 `resolvePanelPrimaryRoot(ctx, sessionId)` → `sessions.get(sessionId).header.cwd` → `canonicalPath` 得到主根；请求体没有 `primaryRoot` 字段（`.strict()` 使旧客户端发送该字段变成 `panel/bad-request`），也没有 `sandboxPolicy.resolve()` 回退。未知或已删除的会话返回 `session-not-found`。没有活动会话时客户端显示空态、不调用 host。`/workspace-folders` 仍用 `invocation.agent.session`（可信 host context），不走这条解析器。见 [ADR-0008](../decisions/ADR-0008-panel-session-derived-authority.md)。host 侧只在组合里同时有 `connection` 与 `webServer`（web profile）时挂载，且服务必须从根上下文读取（cordis 属性解析从插件 fiber 看不见兄弟行提供的 `webServer`，根上下文走共享服务 store；详见 [故障排查：面板 HTTP 405](../troubleshooting/panel-channel-http-405.md)）；headless 上该行只注册命令。
- **不做 Typert 远程命名空间**：出树包的契约生成与 client 装配都没有上游支持路径（ADR-0005）。将来上游提供出树 remote 注册表时，迁移是把 `rpc.handle` 换成 `TypertRemoteService` + 生成的 `/remote`，面板组件与端点语义不变。
- **复用而不占用 picker 洞**：`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` 属于 ui-workspace 的"创建工作区"流程且默认已被 picker 包占满，插件不接入；它复用同一套底层能力（host seam 与 `uiWorkspace` 服务）。

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
