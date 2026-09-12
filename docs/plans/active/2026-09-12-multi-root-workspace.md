# 开发路径文档：Multi-root Workspace（不改上游）

> 状态：active（M1 已完成，正在推进 M2；里程碑概览见下）
> 设计依据：[multi-root-workspace.md](../../architecture/multi-root-workspace.md)；验收标准见 [multi-root-workspace.md](../../requirements/multi-root-workspace.md) §5；M1 详细计划（已完成）：[2026-09-12-m1-composition-and-passthrough.md](../completed/2026-09-12-m1-composition-and-passthrough.md)。
> 产物是本仓库（`dsh-plugin-multi-root-workspace`，包 `@dsh-electron/dsh-plugin-multi-root-workspace`），经 `dsh plugin --profile <name> add <path|git>` 安装；对上游仓库（deepseek-harness）零改动。
> 插件仓库自建门禁（上游 `verify-cordis-config` 等仓库 gates 不适用）：lint + typecheck + vitest 全绿 + patch 快照测试。

## 总体策略

三个里程碑，每个都独立可验证，且**第一步就建立"空根直通 = 上游行为"的安全网**，之后所有增量都在安全网内：

- **M1 组合与直通（已完成）**：bundle 骨架 + 两行替换 + 空根直通。插件已可安装，行为与未装一致；组合、disable/insert 时序与 provide 冲突这三项结构性风险已清零。
- **M2 多根能力**：附加根数据源 + 两个 provider 的多根逻辑 + 方言 grant + parity 测试。
- **M3 Root 管理与 UI**：注册表、命令、client 半部、e2e。

## M1 — bundle 骨架、两行替换、空根直通（已完成）

> 任务清单、设计决定、验证判据、T0 探查结论与实施结果见 **[M1 开发计划（completed）](../completed/2026-09-12-m1-composition-and-passthrough.md)**；本文件只保留里程碑概览，不重复其内容。

相对首版路线的修正（已同步架构与需求文档）：

- 替换集合收窄为两行（`fs-sandbox`、`sandbox`）：bash 与 PTY 的 confinement 全部经 `ctx.sandbox`，`bash-sandbox` 保持上游（[ADR-0001](../../decisions/ADR-0001-provider-replacement-scope.md)）。
- scope 服务在 M1 落地（数据源为空表），provider 只经它取根；M2 只替换数据源，provider 结构不变。
- fs provider 在 M1 即实现 containment（空根时根列表长度为 1），并以差分 parity 测试证明与上游 `SandboxedFileSystem` 等价：`LocalFileSystem` 自身没有 fence，"直通 super"会丢掉 fence。
- 方言 builder 不可深导入（发布包不含 `src/`），M2 改为克隆 `super.confine` 的 grant 模板；识别失败即抛错（[ADR-0002](../../decisions/ADR-0002-upstream-coupling-policy.md)）。

验证（已完成）：`pnpm lint` / `typecheck` / `test`、`pnpm smoke:compose`（30/30）、`pnpm smoke:behavior`（54/54）、`pnpm docs:check`；两个冒烟在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 双运行时上均通过。

## M2 — 附加根数据源与多根 provider

任务（依赖 M1 已拍板的落点）：

- [ ] scope 数据源：把 M1 的空表换成附加根集合（本期仍为测试注入的静态表，M3 才接插件存储）。
- [ ] `MultiRootFileSystem`：多根 containment（`[primaryRoot, ...additionalRoots, /tmp, tmpdir()]`），denial 文案列出全部允许根；空根路径保持与 M1 相同的等价断言。
- [ ] `MultiRootSandboxProvider`：非空根时按方言克隆 `super.confine` 的 grant 模板并插入附加根 grant（Seatbelt allow form / bwrap bind / Landlock rw flag），`enforcement` / `denialSignatures` / `runnerFailureRules` 原样透传；识别失败即抛错；win32 保持 super 并输出一次显式告警（文档明示限制）。
- [ ] **parity 测试套件**（本里程碑的核心资产）：同一 scope 下 fs fence × {Seatbelt, bwrap, Landlock} 对「根内写 / 根外写 / 根间写 / /tmp 写 / read-only 全拒」的允许矩阵一致；空根时与上游行为矩阵一致（对照测试）。
- [ ] `systemPrompt.context` 拓扑快照（空根零输出）。

注：bash 与 PTY 不需要专属实现——它们经 `ctx.sandbox` 自动获得附加根（ADR-0001）。

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
| M1 ✅ | 插件可安装、行为与未装一致；组合结构性风险清零（2026-09-12 完成） |
| M2 | 多根在 macOS/Linux 端到端可用（配置暂用 patch 内静态根） |
| M3 | 完整用户旅程（UI 增删根 → 会话 → Agent 跨 repo 工作） |

## 测试与检查指引

```sh
# 插件仓库（自建门禁）
pnpm typecheck && pnpm lint && pnpm test          # vitest：parity 矩阵、校验纯函数、直通断言
pnpm smoke:compose                                 # dsh --dump-config 组合差分断言（只差两行禁用 + insert）
pnpm smoke:behavior                                # 空根直通行为矩阵（隔离 $DSH_HOME，进程内 boot）

# 升级检查（每次上游发版手动/CI 触发）
# 改 pin（精确版本）后重跑差分 parity + smoke:compose + smoke:behavior；差异即报警（pre-stable API 风险）
```

上游仓库（deepseek-harness）本身在此项目中的唯一用途是**阅读与对照**：不修改任何文件，不在其中跑本插件的 CI；smoke 通过环境内安装的 dsh 运行。

## 风险与开放问题

| # | 风险/问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | 上游 pre-stable API 升级破坏子类（AGENTS.md 明言无 semver 承诺） | 插件可用性 | 精确 pin（`latest` dist-tag 陈旧，必须写死版本，见 ADR-0002）+ 升级 smoke CI；只允许包入口导入；M1 即建立差分对照测试 |
| 2 | 方言 parity 责任转移到插件 | 安全正确性 | M2 parity 测试套件为核心资产；方言 grant 由 `super.confine` 输出克隆模板（上游 builder 在发布形态下不可达），识别失败即抛错（ADR-0002） |
| 3 | ~~bash 子类落点未定~~（已关闭） | — | 不替换 `bash-sandbox`：bash 与 PTY 的 confinement 全部经 `ctx.sandbox`（ADR-0001） |
| 4 | provider 行替换影响未盘点的 Consumer | 隐藏回归 | 已盘点：`ctx.sandbox` 的消费者是 bash-sandbox / pwsh-sandbox / terminal-bash；`ctx.fs` 的消费者是 tool-fs / tool-str-replace-editor。全部只依赖 `confine`、`sandboxMode` 等结构化事实；M1 冒烟逐一实跑 |
| 5 | disable/insert 时序或 id 变化（上游 base patch 行 id 不是稳定承诺） | 组合失败 | duplicate-provide 天然抛错 + 插件身份断言 + `smoke:compose` 组合差分断言 |
| 6 | Windows 内核级多根缺失（pwsh 方言） | Windows bash 场景 | 第一期 fs fence 覆盖 Windows 写路径，文档明示 bash 限制；列入后续阶段 |
| 7 | `isPathUnder` 等价实现的正确性 | fence 语义漂移 | 深导入不可用（发布包不含 `src/`，ADR-0002）⇒ 本地实现 + 注明出处 + M1 差分 parity 套件钉住 |
| 8 | 拓扑快照进入 context 对 prompt cache 的影响 | 长会话成本 | 空根零输出；根集变化频率 = 用户增删根频率，可接受 |
| 9 | nested roots 态度未最终拍板 | 校验规则 | 暂"允许并记录"，M3 前拍板 |
| 10 | 桌面端（apps/desktop）插件安装形态与 CLI profile 的差异 | M3 e2e | 桌面端保留 `$DSH_HOME/profiles/desktop` 装外部插件，机制同源；M3 冒烟验证，若有差异单独记录 |

## 与"可改上游"路线的关系

若未来允许向上游贡献，按架构文档 §9 的 PR 栈提交通用 Filesystem Scope Seam；合入后本插件撤销三个替换行、provider 子类退化为 scope contributor——`FilesystemScope` 接口自 M2 起即按该 seam 目标形态设计，迁移是删除而非重写。
