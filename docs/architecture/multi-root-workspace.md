# 架构文档：Multi-root Workspace（不改上游：provider 替换 + 子类化）

> 状态：**§4、§5.1、§5.3、§6、§7 均已实现（M1/M2/M3）**。已实现部分可按当前仓库代码与 M3 计划中的实施结果验证；§8 的长期演进形态、§9 的上游 seam 附录仍是设计。
> 硬约束：不修改上游仓库（deepseek-harness）任何包；产物是外部 bundle，经 `dsh plugin add` 或 profile patch 组合。
> 事实依据：[multi-root-workspace-research.md](../reference/multi-root-workspace-research.md)（§1-7 上游现状，§8 不改上游机制，§9 发布形态与运行时解析，§10 方言形状与子类可用面）；需求边界：[multi-root-workspace.md](../requirements/multi-root-workspace.md)；排期：[M1 计划](../plans/completed/2026-09-12-m1-composition-and-passthrough.md)、[M2 计划](../plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)
> 修订（2026-09-12）：按 M1 实现前探查收窄替换集合为两行并取消 `MultiRootBashExecutor`（§5.2），依据见 [ADR-0001](../decisions/ADR-0001-provider-replacement-scope.md) 与 [ADR-0002](../decisions/ADR-0002-upstream-coupling-policy.md)；M2 实施后 §5.3 与 §6 改写为已实现的机制（[ADR-0003](../decisions/ADR-0003-dialect-grant-widening.md)）；M3 实施后 §7 改写为已实现的机制（[ADR-0004](../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[ADR-0005](../decisions/ADR-0005-out-of-tree-client-transport.md)）。

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
  - id: multi-root-registry                                # 已实现（M3）
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/registry'
  - id: multi-root-command                                 # 已实现（M3）
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
```

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

- **数据源（已实现）**：§7 的注册表（`dsh-storage-domain` domain `multi_root_workspace`，键 = canonical 主根，记录 `RegisteredRoot { id, path, alias?, addedAt }`）在每次变更后调用 `setAdditionalRoots(root, roots)`；该方法仍是 scope 的公开写口，测试与冒烟脚本可直接使用。provider 结构不随数据源改变——它们只经 `resolve()` / `scopeOf()` 取根。
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

### 5.4 上游 `sandbox-policy` 行不动

`SandboxPolicyService.resolve()` 继续提供 mode 与主根（含 `sandbox/mode` 覆盖、escalation、fallback 语义）。两个子类在其结果上**增广**附加根。mode 语义、`read-only` 全禁、approval、`sandbox/mode` 切换全部继承上游。

## 6. Agent 认知与单一权限世界

- **拓扑注入（已实现）**：`MultiRootScopeService` 注册 `ctx.systemPrompt.context({ name: 'multi-root:scope', order: getContextOrder('SANDBOX_POLICY') + 1, … })`：workspace-write 且有附加根时输出一段稳定拓扑（只列根，不列文件，满足需求 §8），其中声明附加根属于同一 workspace 且 session cwd 不变；空根、`read-only`、以及没有 agent 的诊断装配下都不输出任何内容（空段被 `renderContextSections` 过滤，快照与未装插件逐字节相同）。注册是软依赖：宿主没有 `systemPrompt` seam 时不贡献拓扑也不报错。快照随请求落 model history（上游 `sandbox:policy` 同机制），满足 model-visible ⟺ logged。
- **单一权限世界（已实现）**：fs fence 与内核方言（sandbox provider）消费 §4 的同一份 `FilesystemScope`；bash 与 terminal/PTY 通过 `ctx.sandbox` 间接消费同一份，因此它们的根集合与 fs fence **由构造相同**。插件自带 **parity 矩阵测试**（接替上游 `writableRoots()` 测试的角色）：同一 scope 下，对「主根内 / 主根嵌套 / 附加根内 / 附加根嵌套 / 根外 / 共享词法前缀的兄弟目录 / 经附加根内符号链接逃逸 / 平台临时区」逐类比较 fs fence 的真实写判定与各方言 argv 的授予集合，并在两端模式（workspace-write / read-only）各跑一轮；解析 argv 的代码由测试侧独立实现。宿主能真正执行 runner 时（Linux CI 的 bwrap/Landlock、macOS 的 Seatbelt）另加真实受限执行用例，不能执行时显式 skip 并说明原因。
- 已知不对称（上游既有，非插件引入）：bwrap 与 Landlock 只授予字面 `/tmp`，不授予 `tmpdir()`（调研 §10.3），因此 parity 断言的语义限定为「附加根集合与模式」；Windows 上内核级多根缺失，fs 可写而 bash 不可写（第一期已知限制）。

## 7. Root 管理与 UI（已实现，M3）

三行插件行之外新增两行：`multi-root-registry`（服务）与 `multi-root-command`（用户表面）。前者把注册表喂给 §4 的 scope，后者把命令与面板接到注册表上；两个 provider 完全不知道它们存在。

- **注册表（`MultiRootRegistry`，`ctx.multiRootRegistry`）**：`dsh-storage-domain` 的 domain `multi_root_workspace`（version 1，`single` layout，单表 `roots`），**键 = canonical 主根**，值 = 有序记录 `{ id, path, recordedPath, alias?, addedAt }`。`[Service.init]` 读取全部记录、用与写入相同的规则重新判定、只把可用的根播种进 `ctx.multiRootScope`，并对不可用项输出告警。每次变更先落盘再改内存，成功后重播种 scope 并通知监听者；**同一主根的所有变更在一条 Promise 队列里整体串行**（读快照 → 校验 → 落盘），因为存储域只串行化单个写入，覆盖不到读—改—写。存储整体打不开时降级为"没有附加根 + 所有写操作抛 `storage-unavailable`"，不阻断 harness 启动。取舍见 [ADR-0004](../decisions/ADR-0004-root-registry-persistence-and-validation.md)。
- **读路径的重新校验（`refresh`）**：`registry.refresh(primaryRoot)` 重新 `stat`、重新解析、重新裁决、重播种 scope 并通知监听者，**不写存储**；命令 `list` 与面板 `list` 端点都先走它，所以"列出来的范围"永远等于"此刻授予的范围"（目录消失 → `missing` 且撤销；目录回来 → 恢复授予；目录被替换 → `redirected` 且撤销）。`publish` 只在授予集合或不可用集合变化时才真正动 scope，因此刷新可以随时执行而不产生抖动。`recheck` = refresh + 落盘一次。
- **删除按记录而非按 id**：`removeAt`（以及命令/面板的 remove）一次只删一条记录；重复 id 的异常记录因此可以逐条清理，而按 id 过滤会一次删掉多条。
- **校验（`src/roots.ts` 纯函数，fail loud）**：`~` 展开（只限前导 `~`）→ 必须绝对 → 必须存在且是目录 → `canonicalPath` → 不等于主根 → **不与主根互相包含（`primary-overlap`，双向）** → 不与其他根重复 → 不与任何根互相包含（`nested` 双向拒绝）。失败返回稳定 code（`not-absolute` / `missing` / `not-a-directory` / `equals-primary` / `primary-overlap` / `duplicate` / `nested` / `invalid-alias` / `not-found` / `invalid-ref` / `storage-unavailable` / `reveal-unavailable`），三类表面（命令、面板、内部 API）共用同一词汇。存储读取侧用同一套规则（`classifyStoredRoots`），并额外判定 `recordedPath` 变化（`redirected`）与重复 id（全部 `invalid`）。
- **命令 `/workspace-folders`**：`ctx.commands.register`，语法 `list | add [path] | remove <n|path> | alias <n|path> [name] | reveal <n|path> | help`。无路径的 `add` 软注入 `directoryPicker`，capability 为 `native` 时直接 `pick(signal)`；`browse` 或 seam 缺失时返回明确错误（提示改用面板或传路径）。输出是英文文本（host 侧没有活动语言信息，见需求文档第一期限制）。
- **Client 半部**：`sidebar.footer.action`（list/root，两个受支持运行时都存在）+ 自绘对话框；`ctx.locale.register('multiRootWorkspace', { zh, en })` 双语。动作包含 Add（`ctx.uiWorkspace.pickDirectory()`，退化为手输路径）、Remove、Alias、Copy Path、Reveal、上移/下移。文案按 host 返回的 code 本地化。落点与通道的取舍见 [ADR-0005](../decisions/ADR-0005-out-of-tree-client-transport.md)。
- **通道**：插件自有 Connection RPC channel `/multi-root-workspace`（`connection.rpc.handle` / `connection.rpc.call`），端点为 `list` / `add` / `remove` / `alias` / `move` / `reveal`，返回 `{ ok, value } | { ok, error: { code, message, details } }`。**每个端点的应答形状是显式契约**（`src/contract.ts` 的 `PanelResponseMap`）：`reveal` 返回 `{ revealed }`，其余返回完整 `RootsView`；请求体与应答都在两端做运行时校验（`zod`，与存储 schema 同源），非法请求返回 `panel/bad-request`，形状不符的应答在面板侧变成一条本地化错误而不是渲染崩溃或静默误解。host 侧只在组合里有 `connection`（web profile）时挂载；headless 上该行只注册命令。
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
