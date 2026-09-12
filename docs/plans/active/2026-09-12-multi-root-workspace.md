# 开发路径文档：Multi-root Workspace（不改上游）

> 状态：active（里程碑概览；M1/M2/M3 均已实施完成，详细计划在 `completed/`）
> 设计依据：[multi-root-workspace.md](../../architecture/multi-root-workspace.md)；验收标准见 [multi-root-workspace.md](../../requirements/multi-root-workspace.md) §5；M1 详细计划（已完成）：[2026-09-12-m1-composition-and-passthrough.md](../completed/2026-09-12-m1-composition-and-passthrough.md)；M2 详细计划（已完成）：[2026-09-12-m2-additional-roots-and-dialect-grants.md](../completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)；M3 详细计划（已完成）：[2026-09-12-m3-root-registry-command-and-ui.md](../completed/2026-09-12-m3-root-registry-command-and-ui.md)。
> 产物是本仓库（`dsh-plugin-multi-root-workspace`，包 `@dsh-electron/dsh-plugin-multi-root-workspace`），经 `dsh plugin --profile <name> add <path|git>` 安装；对上游仓库（deepseek-harness）零改动。
> 插件仓库自建门禁（上游 `verify-cordis-config` 等仓库 gates 不适用）：lint + typecheck + vitest 全绿 + patch 快照测试。

## 总体策略

三个里程碑，每个都独立可验证，且**第一步就建立"空根直通 = 上游行为"的安全网**，之后所有增量都在安全网内：

- **M1 组合与直通（已完成）**：bundle 骨架 + 两行替换 + 空根直通。插件已可安装，行为与未装一致；组合、disable/insert 时序与 provide 冲突这三项结构性风险已清零。
- **M2 多根能力（已完成）**：附加根数据源 + 两个 provider 的多根逻辑 + 方言 grant + parity 测试。
- **M3 Root 管理与 UI**：注册表、命令、client 半部、e2e。

## M1 — bundle 骨架、两行替换、空根直通（已完成）

> 任务清单、设计决定、验证判据、T0 探查结论与实施结果见 **[M1 开发计划（completed）](../completed/2026-09-12-m1-composition-and-passthrough.md)**；本文件只保留里程碑概览，不重复其内容。

相对首版路线的修正（已同步架构与需求文档）：

- 替换集合收窄为两行（`fs-sandbox`、`sandbox`）：bash 与 PTY 的 confinement 全部经 `ctx.sandbox`，`bash-sandbox` 保持上游（[ADR-0001](../../decisions/ADR-0001-provider-replacement-scope.md)）。
- scope 服务在 M1 落地（数据源为空表），provider 只经它取根；M2 只替换数据源，provider 结构不变。
- fs provider 在 M1 即实现 containment（空根时根列表长度为 1），并以差分 parity 测试证明与上游 `SandboxedFileSystem` 等价：`LocalFileSystem` 自身没有 fence，"直通 super"会丢掉 fence。
- 方言 builder 不可深导入（发布包不含 `src/`），M2 改为克隆 `super.confine` 的 grant 模板；识别失败即抛错（[ADR-0002](../../decisions/ADR-0002-upstream-coupling-policy.md)）。

验证（已完成）：`pnpm lint` / `typecheck` / `test`、`pnpm smoke:compose`（30/30）、`pnpm smoke:behavior`（54/54）、`pnpm docs:check`；两个冒烟在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 双运行时上均通过。

## M2 — 附加根数据源与多根 provider（已完成）

> 任务清单、设计决定、验证判据与实施结果见 **[M2 开发计划（completed）](../completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)**；本文件只保留里程碑概览，不重复其内容。

相对首版路线的修正（已同步架构与需求文档）：

- `MultiRootFileSystem` 的多根 containment 在 M1 就已实现，M2 的 fs 侧增量是「证明与方言授予集合逐项一致」的 parity 矩阵 + 多根 denial 文案回归。
- 方言 grant 的实现形态定为**结构识别 + 观测克隆 + 已授予跳过**（不给 win32 制造 ACL 副作用、不硬编码上游 flag），识别失败抛 `SandboxUnavailableError`（[ADR-0003](../../decisions/ADR-0003-dialect-grant-widening.md)）。
- 拓扑快照落在 scope 服务内（不新增 patch 行），仅 workspace-write + 非空根输出（空根/只读逐字节不变）。
- 不新增 `windows-latest` CI 腿：win32 行为用 `internals.chain` 在任意宿主上钉住。

验证（已完成）：`pnpm lint` / `typecheck` / `test`（79 项：3 项真实受限执行按宿主能力显式 skip）、`pnpm build`、`pnpm smoke:compose`（30/30）、`pnpm smoke:behavior`（69/69，4 项显式 skip）、`pnpm docs:check`；两个冒烟在 `0.1.5-rc.2` 与 `0.1.2-rc.1` 双运行时上均通过。

## M3 — Root 注册表、命令、client UI、e2e（已实施）

> 任务清单、设计决定、修正依据、验证判据与实施结果见 **[M3 开发计划（completed）](../completed/2026-09-12-m3-root-registry-command-and-ui.md)**；本文件只保留里程碑概览，不重复其内容。

相对首版路线的修正（依据见 M3 计划「对路线图 M3 段落的修正」表）：

- **不接入** `sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`：它们是 ui-workspace「创建工作区」流程的 single 洞且已被默认 picker 包占用；add 改走 host 侧 `ctx.directoryPicker` 与 client 侧 `ctx.uiWorkspace.pickDirectory()`。
- **不使用 Typert 远程命名空间**：出树契约生成不可用（generator 是 workspace 形状）、client 侧 remote 清单是上游静态表；面板改用 Connection RPC 通道（兄弟插件同款公开缝，双运行时可用）。
- 面板落在 `sidebar.footer.action`（两个运行时都存在）+ 自绘对话框；0.1.5 专属的 `sidebar.panellist`/`main` 全屏面板不在 M3。
- 注册表以 **canonical 主根** 为存储键（`ctx.workspaceRegistry` 在 headless 不存在）；nested roots **拍板拒绝**。
- e2e 用真实组合 + 无凭据脚本化模型在进程内驱动真实 agent turn（web 与 headless 各一轮），不引入 Playwright/Electron 车道。

## 里程碑与仓库状态对照

| 里程碑 | 完成时状态 |
|---|---|
| M1 ✅ | 插件可安装、行为与未装一致；组合结构性风险清零（2026-09-12 完成） |
| M2 ✅ | 多根在 macOS/Linux 端到端可用（配置暂用测试/冒烟注入的静态根）（2026-09-12 完成） |
| M3 ✅ | 完整用户旅程（命令/面板增删根 → 会话 → Agent 跨 repo 工作）（2026-09-12 实施） |

## 测试与检查指引

```sh
# 插件仓库（自建门禁）
pnpm typecheck && pnpm lint && pnpm test          # vitest：方言单测、方言 grant 矩阵、空根差分 parity、patch 不变量、客户端拓扑
pnpm smoke:compose                                 # dsh --dump-config 组合差分断言（只差两行禁用 + 五行 insert）
pnpm smoke:behavior                                # 空根直通 + 多根 battery + 注册表/命令 battery（隔离 $DSH_HOME，进程内 boot）
pnpm smoke:journey                                 # 跨两个 git repo 的 web/headless 旅程（脚本化模型，无凭据）

# 升级检查（每次上游发版手动/CI 触发）
# 改 pin（精确版本）后重跑差分 parity + 方言矩阵 + smoke:compose + smoke:behavior；差异即报警（pre-stable API 风险）
```

上游仓库（deepseek-harness）本身在此项目中的唯一用途是**阅读与对照**：不修改任何文件，不在其中跑本插件的 CI；smoke 通过环境内安装的 dsh 运行。

## 风险与开放问题

| # | 风险/问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | 上游 pre-stable API 升级破坏子类（AGENTS.md 明言无 semver 承诺） | 插件可用性 | 精确 pin（`latest` dist-tag 陈旧，必须写死版本，见 ADR-0002）+ 升级 smoke CI；只允许包入口导入；M1 即建立差分对照测试 |
| 2 | 方言 parity 责任转移到插件 | 安全正确性 | 已落地：parity 矩阵测试（测试侧独立解析 argv 授予集合）+ 方言单测为核心资产；方言 grant 由 `super.confine` 输出克隆模板（上游 builder 在发布形态下不可达），识别失败即抛错（[ADR-0003](../../decisions/ADR-0003-dialect-grant-widening.md)） |
| 3 | ~~bash 子类落点未定~~（已关闭） | — | 不替换 `bash-sandbox`：bash 与 PTY 的 confinement 全部经 `ctx.sandbox`（ADR-0001） |
| 4 | provider 行替换影响未盘点的 Consumer | 隐藏回归 | 已盘点：`ctx.sandbox` 的消费者是 bash-sandbox / pwsh-sandbox / terminal-bash；`ctx.fs` 的消费者是 tool-fs / tool-str-replace-editor。全部只依赖 `confine`、`sandboxMode` 等结构化事实；M1 冒烟逐一实跑 |
| 5 | disable/insert 时序或 id 变化（上游 base patch 行 id 不是稳定承诺） | 组合失败 | duplicate-provide 天然抛错 + 插件身份断言 + `smoke:compose` 组合差分断言 |
| 6 | Windows 内核级多根缺失（pwsh 方言） | Windows bash 场景 | 第一期 fs fence 覆盖 Windows 写路径；非空 scope 下 `confine` 保持上游 wrap 并输出一次告警，文档明示限制；列入后续阶段 |
| 7 | `isPathUnder` 等价实现的正确性 | fence 语义漂移 | 深导入不可用（发布包不含 `src/`，ADR-0002）⇒ 本地实现 + 注明出处 + M1 差分 parity 套件钉住；M2 起另由方言矩阵复验 |
| 8 | 拓扑快照进入 context 对 prompt cache 的影响 | 长会话成本 | 已落地：空根 / 只读 / 无 agent 时零输出（逐字节快照断言）；根集变化频率 = 用户增删根频率，可接受 |
| 9 | ~~nested roots 态度未最终拍板~~（已关闭） | — | 已拍板**拒绝**（[ADR-0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)） |
| 10 | 桌面端（apps/desktop）插件安装形态与 CLI profile 的差异 | M3 e2e | 已安装桌面 app 用的是 `web` profile（其自带 runtime 0.1.2-rc.1）；M3 的面板因此落在两个运行时都有的 `sidebar.footer.action` 上，Electron 车道仍未建立（人工验证） |
| 11 | Linux CI 上 bwrap 可能不可用（用户命名空间受限） | 真实执行用例被跳过 | 内核链有第二个 rung（Landlock）；矩阵与冒烟只在 runner 真的不可用时显式 skip，并在输出里说明原因，不把"没跑"记成通过 |

## 与"可改上游"路线的关系

若未来允许向上游贡献，按架构文档 §9 的 PR 栈提交通用 Filesystem Scope Seam；合入后本插件撤销三个替换行、provider 子类退化为 scope contributor——`FilesystemScope` 接口自 M2 起即按该 seam 目标形态设计，迁移是删除而非重写。
