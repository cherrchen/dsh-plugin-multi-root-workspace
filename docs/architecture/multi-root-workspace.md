# 架构文档：Multi-root Workspace（不改上游：provider 替换 + 子类化）

> 状态：Target Architecture 设计稿（待评审；本文描述的是尚未实现的目标设计，不是当前已实现的系统事实）
> 硬约束：不修改上游仓库（deepseek-harness）任何包；产物是外部 bundle，经 `dsh plugin add` 或 profile patch 组合。
> 事实依据：[multi-root-workspace-research.md](../reference/multi-root-workspace-research.md)（§1-7 上游现状，§8 不改上游机制）；需求边界：[multi-root-workspace.md](../requirements/multi-root-workspace.md)

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
                │ systemPrompt.context（拓扑快照） │ patch: disable 上游 3 行 + insert 3 行
                ▼                               ▼
   ctx.systemPrompt（上游）        MultiRootFileSystem        MultiRootBashExecutor      MultiRootSandboxProvider
                                 (extends LocalFileSystem)  (extends LocalBash… 基类)   (extends LocalSandboxProvider)
        Agent                        提供 ctx.fs                 提供 ctx.shell             提供 ctx.sandbox
          │                          多根 fence                  多根 confinement            Seatbelt/bwrap/Landlock 附加 grant
          ▼                               └──────────────┬───────────────────┘──────────────┘
   原生工具 read/write/edit/bash ────────────────────────► 同一个 scope 解析（见 §4）+ 上游 sandboxPolicy（mode/主根，不改）
```

分工一句话：**插件管理"哪些目录属于这个 Workspace"，并用上游同款机制（内核 runner + 进程内 fence）把它们安全地放开**。上游不感知插件存在；未安装插件时一切如常。

## 2. 为什么必须是"替换 provider 行"（备选路径排除）

不改上游时，允许根的判定点全部在上游 provider 内部（`SandboxedFileSystem.checkedTarget`、`SandboxBashExecutor.confine` → `LocalSandboxProvider.confine` → 各方言 profile），且：

- `fs/write-intent` waterfall 只决定版本守卫，不触及 policy，fence 在其后（调研 §8.4）；
- `tools/pre-execute` 设计上禁止改写参数（调研 §8.4）；
- `SandboxExecutionPolicy.workspaceRoot` 单值，替换 `sandbox-policy` 或换 `runnerCommand` 都表达不了多根。

因此唯一语义正确的路径（调研 §8.6 路径 A）：**disable 上游 `fs-sandbox` / `bash-sandbox` / `sandbox` 三行，insert 插件自己的三个 provider**。上游的所有 Consumer（`tool-fs`、`tool-bash`、`terminal-bash`、approval 链）不改一行——它们依赖的只是 Service Definition 接口，而那是最稳定的缝。

被否决的方案：`fs/*` 事件放行（不可行）、`tools/pre-execute` 改写（不可行）、danger-full-access（禁止）、自带完整 provider（`extends FileSystem`，保留为长期形态，见 §8）。

## 3. bundle 结构与组合方式

```text
dsh-plugin-multi-root-workspace/
  package.json            # dsh.bundle.patch: "./cordis.patch.yml" + dsh.client 声明
  cordis.patch.yml
  src/                    # host 半部（见 §4、§5）
  client/                 # client 半部（见 §7）
```

`cordis.patch.yml`（示例，id 命名实现期定）：

```yaml
- id: fs-sandbox          # 上游行 id（base patch :479）
  disabled: true
- id: bash-sandbox        # 上游行 id（base patch :214；win32 本就 disabled）
  disabled: true
- id: sandbox             # 上游行 id（base patch :205）
  disabled: true
- insert:
  - id: multi-root-fs
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
    inject: [sandboxPolicy, multiRootScope]
  - id: multi-root-bash
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/bash'
    inject: [subprocess, sandbox, sandboxPolicy, multiRootScope]
  - id: multi-root-sandbox
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
    inject: [sandboxPolicy, multiRootScope]
  - id: multi-root-scope
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/scope'
  - id: multi-root-command
    name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
    inject: [commands, multiRootScope, workspaceRegistry]
```

要点：上游 `sandbox-policy`、`tool-fs`、`tool-bash`、`terminal-bash` 行**全部不动**——它们继续向 `ctx.fs`/`ctx.shell`/`ctx.sandbox` 要能力。同 key 重复 provide 会抛错（调研 §8.2），所以 disable 必须先于 insert 生效（同一 patch 文档内顺序保证；并在插件 apply 期断言 `ctx.fs`/`ctx.sandbox` 是自己的实例，否则 fail loud）。

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
- **空根直通**：`additionalRoots.length === 0` 时，三个 provider 全部走与上游 byte-identical 的代码路径（fs 直接调用上游 `LocalFileSystem`/`SandboxedFileSystem` 的既有逻辑，bash/sandbox 直接委托上游 `confine`）——验收标准 2。

三个 provider 一律从 `MultiRootScopeService.resolve()` 取根，**不允许任何一个 provider 自行判断路径**（需求 §13）。

## 5. 三个 Provider 子类

### 5.1 `MultiRootFileSystem` — 提供 `ctx.fs`（进程内 fence，全平台）

- `extends LocalFileSystem`（不 extends `SandboxedFileSystem`：其 `checkedTarget` 是 TS-private，跨包子类不能类型安全地复用或覆盖）。
- 保留上游 `SandboxedFileSystem` 的对外行为：`sandboxMode` getter（供 `tool-fs` 的 `FsSandboxController` / escalation UI 使用）、`FS_SANDBOX_DENIED` 错误语义与升级指引文案。
- `writeText` / `editText`：解析 scope → `read-only` 全拒、`workspace-write` 对 `[primaryRoot, ...additionalRoots, /tmp, tmpdir()]` 逐个 `isPathUnder`（复用 `@deepseek-ai/dsh-fs-sandbox/src/containment.ts` 深导入或本地等价实现，二选一在实现期定，倾向本地复制 + 注明出处以减少深导入面）、`danger-full-access` 放行。写路径本体（原子写、edit 临界区、锁）调用上游 `LocalFileSystem` 实现——**不重写 IO**。
- 多根 denial 文案列出全部允许根；escalation 沿用上游 API（只放宽 mode，不放宽根）。

### 5.2 `MultiRootBashExecutor` — 提供 `ctx.shell`（一次性 bash）

- 落点二选一（开放问题，实现期以最小重实现量定）：`extends SandboxBashExecutor`（复用 mode 解析与 escalation，但 `confine` 是 TS-private，需 override `run`/`start` 在外层接管 confinement）或 `extends LocalBashExecutor` 自管。推荐后者起步：行为面完整自控，`SandboxBashExecutor` 的增量逻辑（mode/escalation 包装）以同等语义重写并测试钉住。
- confinement：经 `ctx.sandbox`（即 §5.3 的多根 provider）执行；workdir 相对路径以 `scope.primaryRoot` 为基准（与上游 `resolveWorkdir` 行为一致）。

### 5.3 `MultiRootSandboxProvider` — 提供 `ctx.sandbox`（内核方言，覆盖 terminal/PTY）

- `extends LocalSandboxProvider`（`confine(argv, policy)` 是 public，可直接扩展；`internals` public）。
- override `confine`：先 `super.confine(argv, policy)` 得到上游单根 argv/profile，再按方言**追加**附加根 grant：
  - **Seatbelt (darwin)**：向上游拼好的 profile 追加 `(allow file-write* (subpath "<root>"))` 形式（每附加根一条；若 profile 是整体字符串则做受控拼接，实现期确认 builder 导出形态，开放问题）。
  - **bwrap (linux)**：在 runner argv 中为每个附加根插入等价的可写 bind 参数（与上游临时 `/tmp` mount 的既有差异保持一致）。
  - **Landlock (linux)**：为每个附加根追加对应的 LAW 路径 flag（launcher-owned，与上游语义一致）。
  - **Windows ACL**：第一期不扩展（fs fence 已覆盖 Windows 写路径；pwsh 内核级多根列入后续阶段），`confine` 在 win32 上保持 super 行为并在文档明示限制。
- 若上游 profile builder 未从 `dsh-sandbox-local` 导出：自拼 + 用 parity 测试钉住（见 §6），并在插件内注明复制出处。

### 5.4 上游 `sandbox-policy` 行不动

`SandboxPolicyService.resolve()` 继续提供 mode 与主根（含 `sandbox/mode` 覆盖、escalation、fallback 语义）。三个子类在其结果上**增广**附加根。mode 语义、`read-only` 全禁、approval、`sandbox/mode` 切换全部继承上游。

## 6. Agent 认知与单一权限世界

- **拓扑注入**：插件注册自己的 `ctx.systemPrompt.context({ name: 'multi-root:scope', ... })`，workspace-write 且有附加根时输出稳定拓扑（只列根，不列文件，满足需求 §8）；快照随请求落 model history（上游 `sandbox:policy` 同机制），满足 model-visible ⟺ logged。空根时不输出任何内容（不影响 prompt cache 与既有快照）。
- **单一权限世界**：fs fence、bash、terminal、sandbox provider 全部消费 §4 的同一份 `FilesystemScope`；插件自带 **parity 测试**——同一 scope 下，进程内 fence 与三种内核方言对"根内/根间外/临时区"的允许矩阵一致（接替上游 `writableRoots()` 测试的角色）。

## 7. Root 管理与 UI（与上游约束无关，全部走公开 API）

- **校验规则**（`resolve(request): Spec` 显式步骤，fail loud）：输入存在且是目录 → `canonicalPath` → 判重（duplicate / ==primary 默认拒绝 / nested 默认允许并记录）→ 入库；启动与每次播种前 re-check 存在性，缺根按 config 跳过 + 用户可见通知。
- **命令** `/workspace-folders`（list/add/remove/alias/reveal）：`ctx.commands.register`；add 经 `directoryPicker.pick`（Typert 远程命名空间，桌面原生对话框 / 浏览器内浏览）。
- **可选内省工具** `workspace_roots`：零参数只读；先验证 §6 拓扑文案是否已满足 Agent 认知，够用则不做（需求 §9 预留删除条件）。
- **Client 半部**：`ctx.slots.inject` 挂进 `ui-workspace` 既有结构，Folders 面板（主根/附加根标记、Add/Remove/Reveal/Copy Path/Alias）；占据 `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow` picker 洞；文案走 `ctx.locale.register(ns, { zh, en })`。桌面端（apps/desktop）与 web 共用 client graph，零专属代码。
- **远程通道**：插件新增自己的 Typert 命名空间（如 `multiRootWorkspace`）承载 UI ↔ host 的 CRUD；不直读其他插件存储。

## 8. 演进形态

- **当前（路径 A）**：替换三行 + 子类。风险集中在上游 pre-stable 升级。
- **升级韧性**：插件 `package.json` pin dsh 精确版本；仓库 CI 加"升级 smoke"——`pnpm up` 后跑最小行为用例（空根直通 + 多根写入 + 根外拒绝），差异即报警；子类只依赖公开方法面（禁止 `#` 假设、禁止原型替换）。
- **长期（路径 D / 上游 seam）**：若上游未来接受通用 Filesystem Scope Seam（`ctx.filesystemScope` contributor + `writableRoots()` 数组化 + 方言数组化，见 §9），插件撤销三个替换行，provider 子类退化为薄 scope contributor；`FilesystemScope` 接口即按该 seam 的目标形态设计，迁移是删除而非重写。

## 9. 附录：可改上游时的理想 seam（备忘）

若约束解除，向上游提交的 PR 栈为：① `SandboxExecutionPolicy.additionalRoots` + `writableRoots()` 数组化（`packages/sandbox/sandbox/src/roots.ts`，语义唯一 home）；② `ctx.filesystemScope` contributor seam（新包 `packages/fs/fs-scope`，含 `workspace/scope` log-only 事件 + projection，照 `sandbox/mode` 模板）；③ `SandboxPolicyService.resolve` 合并 + `renderPolicyContext` 拓扑句；④ fs fence any-of-roots + bwrap/Landlock/ACL 方言数组化；⑤ `renderPolicyContext` 空根字节级不变。届时本插件仅保留 root 注册表与 UI，三行替换撤销。此附录保留本设计文档的完整性，当前不执行。

## 10. 被否决的方案（本约束下）

| 方案 | 否决理由 |
|---|---|
| `fs/write-intent` 等事件"放行" | single-slot decision 只决定版本守卫，不触及 policy；fence 在 provider 内部之后（调研 §8.4） |
| `tools/pre-execute` 改写 path/policy | 设计上禁止 input rewriting；`FsSandboxController` 无事件口子（调研 §8.4） |
| 替换 `sandbox-policy` 表达多根 | `workspaceRoot` 单值，所有消费方只读它 |
| danger-full-access + 提示词约束 | 需求 §10/§20 禁止 |
| 自带完整 fs/bash provider（路径 D） | 当前成本最高（重做 IO 临界区），保留为升级韧性耗尽后的长期形态 |
| 自有 session 事件承载 scope | 未装插件的 dsh 会拒绝打开含未知事件类型的日志（required-on-read）；第一期用插件存储 + canonical cwd 索引替代 |
