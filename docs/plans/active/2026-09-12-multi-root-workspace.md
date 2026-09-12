# 开发路径文档：Multi-root Workspace（不改上游）

> 状态：active（尚未开始实施，待评审）
> 设计依据：[multi-root-workspace.md](../../architecture/multi-root-workspace.md)；验收标准见 [multi-root-workspace.md](../../requirements/multi-root-workspace.md) §5。
> 产物是本仓库（`dsh-plugin-multi-root-workspace`，包 `@dsh-electron/dsh-plugin-multi-root-workspace`），经 `dsh plugin --profile <name> add <path|git>` 安装；对上游仓库（deepseek-harness）零改动。
> 插件仓库自建门禁（上游 `verify-cordis-config` 等仓库 gates 不适用）：lint + typecheck + vitest 全绿 + patch 快照测试。

## 总体策略

三个里程碑，每个都独立可验证，且**第一步就建立"空根直通 = 上游行为"的安全网**，之后所有增量都在安全网内：

- **M1 组合与直通**：bundle 骨架 + 三行替换 + 空根直通。此步完成后插件已可安装且行为与未装完全一致——先落地最大的结构性风险（组合、disable/insert 时序、provide 冲突）。
- **M2 多根能力**：scope 服务 + 三个 provider 的多根逻辑 + 方言 grant + parity 测试。
- **M3 Root 管理与 UI**：注册表、命令、client 半部、e2e。

## M1 — bundle 骨架、三行替换、空根直通（≈ 结构风险清零）

任务：

- [ ] 仓库脚手架：package.json（`dsh.bundle.patch`、`dsh.client`、pnpm 依赖 `@deepseek-ai/dsh-fs-local` / `dsh-fs-sandbox` / `dsh-bash-sandbox` / `dsh-sandbox-local` / `dsh-sandbox-policy` 等，**精确 pin dsh 版本**）、`cordis.patch.yml`（disable `fs-sandbox`/`bash-sandbox`/`sandbox` + insert 占位行）、tsconfig（extends 上游仓库 client/host 两套 face 的等效配置）。
- [ ] 占位 provider：三个子类先零改动（`extends LocalFileSystem` / bash 基类 / `LocalSandboxProvider`，全部方法直通 super），注入期断言 `ctx.fs`/`ctx.shell`/`ctx.sandbox` 是自己的实例（否则 fail loud，防 disable 未生效）。
- [ ] 组合验证：`dsh --profile web --dump-config` 确认三行替换；空根下跑一遍读/写/bash 用例确认与上游行为一致（这是验收标准 2 的第一个数据点）。
- [ ] 确认开放问题：bash 子类落点（`LocalBashExecutor` vs `SandboxBashExecutor`）；`dsh-sandbox-local` profile builder 的导出形态（决定方言拼接方式）；`sandbox` 行替换对 terminal/PTY 的影响面（跑一个 terminal 用例）。

验证：`dsh plugin --profile web add <本地路径>` 安装 → dump-config → 手动 smoke。插件仓库 CI 建立（lint/typecheck/test + 组合 smoke 脚本，用环境内 dsh）。

## M2 — scope 服务与多根 provider

任务（依赖 M1 拍板的两个落点）：

- [ ] `MultiRootScopeService`：canonical cwd → 附加根解析（本期数据源是测试注入的静态表，M3 才接存储）；`FilesystemScope` 类型。
- [ ] `MultiRootFileSystem`：`sandboxMode` getter、`writeText`/`editText` 多根 containment（`isPathUnder` 等价实现）、denial 文案列根、escalation 语义保持、空根直通断言。
- [ ] `MultiRootSandboxProvider`：override `confine`，方言附加 grant——darwin Seatbelt allow form 追加、linux bwrap bind / Landlock flag 插入、win32 保持 super（明示限制）。
- [ ] `MultiRootBashExecutor`：confinement 经 `ctx.sandbox`；workdir 基准 = `primaryRoot`。
- [ ] **parity 测试套件**（本里程碑的核心资产）：同一 scope 下 fs fence × {Seatbelt, bwrap, Landlock} 对「根内写 / 根外写 / 根间写 / /tmp 写 / read-only 全拒」的允许矩阵一致；空根时与上游行为矩阵一致（对照测试）。
- [ ] `systemPrompt.context` 拓扑快照（空根零输出）。

验证：插件仓库 vitest 全绿；在宿主环境装上插件后 headless 实跑「写附加根成功 / 写根外被拒 + 升级指引 / read-only 拒绝」。macOS 本地 + Linux CI（bwrap/Landlock）；Windows 仅 fs fence 用例。

## M3 — Root 注册表、命令、client UI、e2e

任务：

- [ ] 注册表：`dsh-storage-domain` KvTable、`AdditionalWorkspaceRoot`（branded id）、add/remove/alias/list/order。
- [ ] 校验纯函数：canonical 化 + duplicate/==primary/nested/missing 五类规则（全分支 100%）；启动缺根降级 + 用户可见通知。
- [ ] `/workspace-folders` 命令（add 经 `directoryPicker.pick`）。
- [ ] 可选 `workspace_roots` 内省工具（先验证 M2 拓扑文案是否够用，需求 §9 的删除条件）。
- [ ] client 半部：`WorkspaceFolders` 面板（主根/附加根标记、Add/Remove/Reveal/Copy Path/Alias）、picker 洞接入（`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`）、`ctx.locale.register(ns, { zh, en })` 双语、Typert 远程命名空间 `multiRootWorkspace`。
- [ ] e2e（验收标准 11）：web + headless 双 profile，跨 repo 读写、双 repo 测试、git diff；桌面端（apps/desktop）冒烟。
- [ ] 插件 README + 升级 smoke CI（`pnpm up dsh` 后跑最小行为矩阵）。

## 里程碑与仓库状态对照

| 里程碑 | 完成时状态 |
|---|---|
| M1 | 插件可安装、行为与未装一致；组合结构性风险清零 |
| M2 | 多根在 macOS/Linux 端到端可用（配置暂用 patch 内静态根） |
| M3 | 完整用户旅程（UI 增删根 → 会话 → Agent 跨 repo 工作） |

## 测试与检查指引

```sh
# 插件仓库（自建门禁）
pnpm typecheck && pnpm lint && pnpm test          # vitest：parity 矩阵、校验纯函数、直通断言
pnpm smoke:compose                                 # dsh --dump-config 断言三行替换
pnpm smoke:behavior                                # 空根直通 + 多根写入/拒绝矩阵（宿主 dsh）

# 升级检查（每次上游发版手动/CI 触发）
pnpm up '@deepseek-ai/dsh-*' && pnpm smoke:behavior  # 差异即报警（pre-stable API 风险）
```

上游仓库（deepseek-harness）本身在此项目中的唯一用途是**阅读与对照**：不修改任何文件，不在其中跑本插件的 CI；smoke 通过环境内安装的 dsh 运行。

## 风险与开放问题

| # | 风险/问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | 上游 pre-stable API 升级破坏子类（AGENTS.md 明言无 semver 承诺） | 插件可用性 | 精确 pin + 升级 smoke CI；子类只碰公开方法面；M1 即建立直通对照测试，破坏会第一时间暴露 |
| 2 | 方言 parity 责任转移到插件 | 安全正确性 | M2 parity 测试套件为核心资产；方言 grant 拼接尽量调用上游 builder（导出形态 M1 确认），否则自拼 + 测试钉住 + 注明复制出处 |
| 3 | bash 子类落点未定 | M2 实现路径 | M1 拍板：倾向 `extends LocalBashExecutor` 自管 confinement（行为面完整自控），`SandboxBashExecutor` 的 mode/escalation 包装同等语义重写 |
| 4 | `sandbox` 行替换影响 terminal/PTY/其他未盘点 Consumer | 隐藏回归 | M1 盘点 `ctx.sandbox` 与 `ctx.shell` 的全部 Consumer（terminal-bash 已知）并逐一进 smoke |
| 5 | disable/insert 时序或 id 变化（上游 base patch 行 id 不是稳定承诺） | 组合失败 | 插件 apply 期断言 provider 身份（fail loud）；smoke:compose 快照断言 |
| 6 | Windows 内核级多根缺失（pwsh 方言） | Windows bash 场景 | 第一期 fs fence 覆盖 Windows 写路径，文档明示 bash 限制；列入后续阶段 |
| 7 | `isPathUnder` 等价实现的正确性 | fence 语义漂移 | 优先深导入上游实现（exports `"./src/*"` 可达），退而复制并对照测试 |
| 8 | 拓扑快照进入 context 对 prompt cache 的影响 | 长会话成本 | 空根零输出；根集变化频率 = 用户增删根频率，可接受 |
| 9 | nested roots 态度未最终拍板 | 校验规则 | 暂"允许并记录"，M3 前拍板 |
| 10 | 桌面端（apps/desktop）插件安装形态与 CLI profile 的差异 | M3 e2e | 桌面端保留 `$DSH_HOME/profiles/desktop` 装外部插件，机制同源；M3 冒烟验证，若有差异单独记录 |

## 与"可改上游"路线的关系

若未来允许向上游贡献，按架构文档 §9 的 PR 栈提交通用 Filesystem Scope Seam；合入后本插件撤销三个替换行、provider 子类退化为 scope contributor——`FilesystemScope` 接口自 M2 起即按该 seam 目标形态设计，迁移是删除而非重写。
