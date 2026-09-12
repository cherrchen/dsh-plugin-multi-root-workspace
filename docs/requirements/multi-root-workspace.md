# 开发需求文档：DSH Multi-root Workspace（out-of-tree 插件，不改上游）

> 状态：待评审 | 日期：2026-09-12 | 上游需求：用户提供的《DSH Multi-root Workspace 插件需求总结》
> **硬约束：不得修改上游仓库（deepseek-harness）中任何包**——全部产物是外部插件/bundle，通过 `dsh plugin add` 或 profile patch 组合安装。
> 事实依据：[multi-root-workspace-research.md](../reference/multi-root-workspace-research.md)（§8 为不改上游的补充调研）；设计：[multi-root-workspace.md](../architecture/multi-root-workspace.md)；排期：[2026-09-12-multi-root-workspace.md](../plans/active/2026-09-12-multi-root-workspace.md)

## 1. 需求陈述

将 DSH 的 Workspace 语义从

```text
Workspace = 一个 canonical 目录
```

扩展为

```text
Workspace = 一个 Primary Root（既有 workspace.path，不改）+ N 个 Additional Roots
```

使 Agent 能在同一个 Session 中理解、读取、搜索和修改属于同一开发项目的多个独立 Git Repository，同时：

- Agent 继续只使用 DSH 原生工具（`read` / `write` / `edit` / `bash` / ...）；
- 所有路径安全与进程隔离继续由 DSH 原生 Sandbox 机制（Seatbelt / bwrap / Landlock / fs fence）提供，绝不退化为 danger-full-access 或提示词约束；
- 插件只回答一个问题："哪些目录属于当前 Workspace"。

## 2. 可行性结论（不改上游约束下）

**可以实现，但实现路径与"可改上游"的设想不同，且要接受两条明确的代价。**

可行依据（详见 [multi-root-workspace-research.md](../reference/multi-root-workspace-research.md) §8）：

1. **patch 层支持 disable 旧行 + insert 新行**，且外部 bundle 的 `dsh.bundle.patch` 会被 `dsh plugin add` 自动追加为组合层、可 patch base bundle 的行。上游单根语义虽然锁在 `writableRoots()` 与各方言内部，但其 provider 都是可 import、可子类化的公开类（`SandboxedFileSystem` / `SandboxBashExecutor` / `LocalSandboxProvider` / `LocalFileSystem`，无 `#` true-private 成员）。
2. **替换是完整的**：disable `fs-sandbox`、`bash-sandbox`、`sandbox` 三行后由插件提供同 key 服务（上游同 key 重复 provide 会抛错，所以必须先 disable），上游的 `sandbox-policy`、`tool-fs`、`tool-bash`、`terminal-bash` 等消费者无需改动——它们继续向 `ctx.fs` / `ctx.shell` / `ctx.sandbox` 请求能力，只是拿到的实现变成了多根版本。
3. **被排除的捷径**：`fs/*` 事件（只决定版本守卫 intent，fence 在其后的 provider 内部）与 `tools/pre-execute`（设计上禁止参数改写）都不能放行额外根——多根必须发生在 provider 层。

两条代价（已写进风险与验收）：

- **方言 parity 责任转移**：上游用 `writableRoots()` 保证"write 工具能写的根 bash 一定能写（反之亦然）"并有 parity 测试钉住；替换后这条不变量由插件自己维护。
- **升级脆弱性**：上游 API 是 pre-stable（无 semver 承诺），子类依赖 `LocalFileSystem` / `LocalBashExecutor` / `LocalSandboxProvider` 的公开方法面，上游升级可能破坏插件；必须 pin dsh 版本并建立升级 smoke 检查。

若未来允许向上游贡献，[架构文档 §9](../architecture/multi-root-workspace.md) 给出了"通用 Filesystem Scope Seam"的目标形态：届时插件的子类实现退化为薄 provider，替换行撤销。

## 3. 逐条需求 → 实现机制映射

| 需求（原文节号） | 不改上游下的机制 | 结论 |
|---|---|---|
| §4 不重实现原生设施；不造 `workspace_*` 工具 | 原生工具链（tool-fs / tool-bash / terminal）不动；插件零工具（可选一个内省工具）。注意：插件会**子类化**上游 fs/bash/sandbox provider——这是"扩展"，不是重实现；文件 IO、进程、内核 runner 全部复用上游 | 满足（含澄清） |
| §5.1 Root 管理 | 插件注册表 + `dsh-storage-domain` 持久化 + `canonicalPath` 校验 | 插件职责 |
| §5.2 Workspace Folders UI | slot 洞 + `directoryPicker` + locale 字典 | 插件 client 半部 |
| §6 保留 Workspace.path 为 Primary Root | 现状即如此，不碰 | 零改动 |
| §7 不改 Session cwd 语义 | `header.cwd` 不可变 | 零改动 |
| §8 Agent 认知：稳定 topology | 插件自己的 `ctx.systemPrompt.context` 快照（快照随请求落 log，满足 model-visible ⟺ logged） | 插件职责 |
| §9 可选 `workspace_roots()` 内省工具 | `ctx.tools.register(defineTool(...))` | 插件可选件 |
| §10 Sandbox 原则：多 allow roots，不开 danger-full-access | 子类 provider 在同一内核机制内拼装多根 grant（Seatbelt 多条 allow form / bwrap 多个 writable mount / Landlock 多个 LAW path / fs fence any-of-roots） | 满足 |
| §11/§12 通用 seam、Core 不认识插件 | **不受约束时的理想形态**（架构文档 §9）；不改上游时以"多根 provider 子类"代位，seam 词汇（附加可写根贡献者）保留在插件内部接口上 | 部分满足，见 §2 代价 |
| §13 单一权限世界 | fs / bash / terminal 全部从插件的同一个 scope 解析取根；插件自带 parity 测试钉住 | 满足，责任在插件 |
| §14 数据模型：插件只存 Additional Roots | `AdditionalWorkspaceRoot { id, path, alias?, addedAt }` per workspaceId | 插件职责 |
| §15 Root Path 规则 | `realpathSync.native` canonical 化 + 五类冲突校验 | 插件职责 |
| §16 初版附加根继承 workspace-write | 附加根与主根同权，无 per-root mode | 第一期范围 |
| §17 `*.dsh-workspace.json` | 第一期不做；storage 为唯一数据源 | 后续阶段 |
| §18 兼容性：不装/无根 = 单目录行为 | 未安装：组合零变化。安装且根列表为空：子类行为与上游 byte-identical（子类在空附加根时直通上游实现路径） | 验收标准 |
| §19 其他插件经 Workspace Filesystem Capability 查询 scope | 插件暴露自己的 scope 查询 service（非私有数据库直读）；上游 seam 成熟后迁移 | 长期目标 |
| §22 用户体验 | 原生工具 + 扩展 allow-list，端到端验收 | 验收场景 |

## 4. 范围

### 第一期（MVP）

- 插件 host 半部：root 注册表（storage 持久化）、canonicalization 与冲突校验、scope 解析 service、`systemPrompt.context` 拓扑快照、`/workspace-folders` 命令、可选 `workspace_roots` 工具。
- 插件 provider 半部（本约束下的核心增量）：多根 `fs`（进程内 fence）、多根 `bash` 执行器、多根 `sandbox` provider（Seatbelt / bwrap / Landlock 方言的附加 grant 拼装）；通过 bundle patch disable 上游三行并插入。
- 插件 client 半部：Workspace Folders UI、directory picker 接入、双语 locale。
- 平台范围：macOS（Seatbelt）、Linux（bwrap / Landlock）全量；Windows 的 fs fence 多根可用，内核级 bash 多根（pwsh 方言）**不在第一期**（fs 写路径已覆盖 Windows 大部分场景；文档明示）。
- profile 覆盖：`web`（含 Electron 桌面端）与 `headless` 验证；`sdk`/`acp` 天然受益（同一组合方式）。

### 后续阶段（不在第一期）

- Windows pwsh 内核级多根。
- Read-only root / per-root / per-tool 权限。
- `*.dsh-workspace.json` Import/Export。
- `workspace-files`（Client 文件树）多根 confine——第一期 Client 文件浏览仍只展示主根，属已知限制。
- SDK API；以及（若政策放开）向上游贡献通用 Filesystem Scope Seam 并撤销子类替换（架构文档 §9）。

## 5. 验收标准

1. **不装插件**：组合与行为与现状完全一致（本条由"插件是外部 bundle"天然保证）。
2. **安装且根列表为空**：`fs` / `bash` / `sandbox` 的行为与上游实现 byte-identical（子类空根直通上游代码路径）；`dsh --dump-config` 仅显示三行被替换。
3. **多根生效**：添加附加根后的新 Session 中——对附加根内路径的 `write` / `edit` 成功；`bash` 在附加根内创建/修改文件成功（macOS Seatbelt、Linux bwrap 与 Landlock）；附加根外任意路径写入仍被拒绝并返回升级指引；`read-only` 模式下附加根同样不可写。
4. **单一权限世界**：插件自建 parity 测试——同一 scope 下 fs fence 与内核 runner 对附加根内外的写行为一致；不存在任一工具能写附加根而另一工具不能的组合。
5. **cwd 不变**：多根 Session 的 `header.cwd`、`workspace.path`、transcript cwd 显示均为主根；无虚拟 cwd。
6. **模型可见 ⟺ 已记录**：拓扑文案经 `systemPrompt.context` 快照落 log；快照回放能重建相同拓扑。
7. **Path 规则**：`~/p`、`/abs/p`、`/abs/../abs/p`、symlink 别名 canonical 化后判重；与主根相同的附加根被拒绝并给出明确错误；缺失目录添加时拒绝、启动时降级为"跳过 + 用户可见通知"，不静默。
8. **失败要响亮**：misconfiguration（非绝对路径、重复 id、patch 行未按预期生效）在装载或首次 resolve 时抛错。
9. **UI**：Folders 列表区分主根/附加根；Add Folder 走 `directoryPicker`；Remove/Reveal/Copy Path/Alias 可用；双语并通过 locale 门禁（仓库内含 client 包时）。
10. **升级韧性**：`package.json` pin dsh 精确版本；仓库 CI 含"升级 smoke"脚本（对上游 demo 行为差异报警）；provider 子类只依赖上游公开方法面（不触碰 TS-private、不做原型替换）。
11. **e2e**：需求 §22 场景实跑通过（跨 repo 读写、双 repo 测试、git diff），headless + web 双 profile。

## 6. 非目标（明确不做）

- 不实现任何 `workspace_read/write/edit/bash/exec` 工具。
- 不通过 danger-full-access、System Prompt 约束、DOM patch、虚拟 cwd、fork `dsh-workspace` 实现多根。
- 不修改上游仓库（deepseek-harness）任何包（含 vendor/、apps/、scripts/）；其仓库 gates（`verify-cordis-config` 等）按 out-of-tree 形态不适用于插件仓库，插件仓库自建等价检查。
- 不 append 自有 session 事件类型（避免"未装插件的 dsh 拒绝打开日志"的兼容风险；会话级 scope 以插件存储按 canonical cwd 解析，见架构文档 §4）。
- 不改 `SandboxMode` 三值语义、escalation、approval。

## 7. 开放问题（详见 [开发路径文档 §风险](../plans/active/2026-09-12-multi-root-workspace.md)）

- bash 子类化的落点：`extends SandboxBashExecutor`（复用其 mode/escalation 逻辑，但 `confine` 是 TS-private，需在外层重排）还是 `extends LocalBashExecutor` 自管 confinement——实现期以最小重实现量定夺。
- Seatbelt/bwrap/Landlock profile 构建函数是否从 `dsh-sandbox-local` 公开导出（决定"拼接附加 grant"是调用上游 builder 还是自拼 + 测试钉住）。
- `sandbox` provider 行替换对 terminal/PTY 链路的影响面确认。
- nested roots 最终态度（暂按"允许并记录"）。
