# 个人 SSH 工具硬化：参数、错误文案与输出预算（2026-11-23）

> 状态：**实施完成，本机门禁通过，已合入 `main`（PR [#78](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/78)，`d7f82c1`）并随 `v0.1.24-beta.5` 发版**（分支 `feat/harden-remote-tool`）。
>
> 关联：[SSH 参考](../../reference/ssh-remote-environments.md)、[控制面参考](../../reference/multi-environment-control-plane.md)、[ADR-0032](../../decisions/ADR-0032-upstream-ssh-backend.md)、[ADR-0033](../../decisions/ADR-0033-remote-command-and-sandbox.md)、[ADR-0034](../../decisions/ADR-0034-binary-transfer.md)、[ADR-0049](../../decisions/ADR-0049-ssh-custody-modes.md)、[路线图总账](./2026-09-12-multi-root-workspace.md#个人-ssh-工具硬化2026-11-23)。

## 1. 目标与范围

本批解决个人 SSH 工具的三类可用性问题，并补齐传输属性与后续扩展的记录：

1. **参数可构造。** `remote_copy` 的 `from`/`to` 使用同一参数定义；两侧 `environmentId` 均可省略并缺省为 `local`，本地主根为 `local:primary`，附加根用 `aliasId`，远端端点必须显式给出环境 ID；工具描述含一次上传与一次下载示例。两个工具的广告 schema 与 execute 边界校验使用同一份声明，覆盖缺字段、错误类型、未知字段与嵌套对象；只有省略 `environmentId` 才取默认值，`null` 与空串是参数错误；结构错误以带字段位置的 `invalid-arguments` 在 Registry 准入与 SSH/SFTP I/O 之前结束。`remote_bash` 仍要求显式远端环境，Session 与工具名只取可信调度上下文。
2. **错误可操作。** 保留 `status`/`code`/`stage`/`staging`/`operationId`/`reconcileId` 语义，为可诊断失败补充有界 `message`/`hint`；文案只由稳定错误码与安全字段生成，不把系统异常、SSH 错误原文或凭据路径送入模型上下文。`invalid-cwd`、`destination-parent-missing`、`local-root-unavailable` 各有针对性提示；端点类错误附有界 `environmentId:rootId` 候选，候选来自当前 Session 主根的 Registry 快照，按登记状态、方向、读写/执行权限与已知对端配对筛选，读取不建连；快照不可用时保留原错误与通用提示；`unknown`/`admitted-may-start` 保持不确定性，不建议盲重试。
3. **输出可控。** `remote_bash` 的 stdout 与 stderr 默认各预览最多 64 KiB，并将 JSON 转义计入预算。`maxOutputBytes` 可在部署上限内显式调节。SSH 适配器保留上游文本，逐流报告可证实的 `totalBytes` 与 `droppedBytes`。
4. **传输属性与后续。** 中英指南与技术参考记录当前只支持单个普通文件、目标以 0600 创建、不保留源 mtime、目标存在即拒绝，并给出"先在已授权根内打包、再按单文件复制"的示例；后续单独评估保留执行位与 mtime（在已绑定 staging 对象上核验并应用元数据、按方向定义失败行为、默认仍 0600）、显式覆盖授权与 `expectSha256` 并发条件替换、目录递归/解包的独立路径约束与失败回收。

**非目标：** 自动落盘与结果引用（需先定容量、清理与读取准入）、覆盖已有目标、保留元数据、目录递归、Broker 发布、修改上游任何包。

## 2. 设计与实现

**共享声明（`src/remote/tool-arguments.ts`）。** 两套 JSON Schema 同时用于工具注册与 `parseRemoteCopyArguments`/`parseRemoteBashArguments` 的 execute 边界校验；校验器解释的正是注册出去的那份对象（类型、必填、`additionalProperties: false`、`minLength`/`maxLength`/`minimum`），因此广告规则与执行规则不会漂移。`remote_copy` 的 `from`/`to` 引用同一个端点 schema 对象。默认值只在解析阶段应用：省略的 `environmentId` 变 `local`，省略的 `cwdRelative` 变 `""`；显式 `null`/`""` 在结构校验阶段失败。标签片段经 `safeLabelPart` 去控制字符并限长后才进入结果。

**结果文案与候选（`src/remote/result-guidance.ts`、`src/remote/endpoint-candidates.ts`）。** 候选读取 `registry.remoteList(primary)`（一秒上限）与当前清单。复制候选使用 Registry 提供的会话模式及工具限制，筛选双方配对并纳入可用本地根。命令失败提示保留直接进程已退出但托管范围未确认的状态。

**工具接线。** `src/remote/transfer.ts`：结果增加 `message`/`hint`；`runRemoteCopy` 的失败出口统一经 `fail`（含 `unknown`/`cancelled` 结果），准入失败后先读候选；`codeOf` 只放行稳定小写错误码，其余归为 `transfer-failed`。`src/remote/exec-tool.ts`：execute 边界先解析，`"local"` 作为 `environmentId` 同样被拒；`src/remote/exec.ts`：`notStarted` 携带文案，准入 A/B 的异常在返回前读候选，`invalid-cwd` 使用已准入 `displayPath`，`unknown`/`admitted-may-start` 与三种 `termination` 各有不确定性/终止提示，`checkCwd` 的错误码同样只放行稳定码。

**输出预算（`src/remote/output-budget.ts`、`exec.ts`、`ssh-exec-backend.ts`）。** 准入 B 创建两路 sink，每路上限为调用预算与部署上限的较小值。先截取原始窗口，再在完整 Unicode 字符边界按 JSON 字节预算裁剪。计数按最终文本实际保留的字节计算。适配器保留上游文本，无法证明映射时丢弃量为 `null`。

**部署上限。** 个人 SSH 新草稿使用 stdout 1 MiB、stderr 256 KiB，支持显式调高工具预览。未发布 broker 客户端的 64 KiB 回退继续复用预览常量。

## 3. 变更文件

- 新增：`src/remote/output-budget.ts`、`src/remote/tool-arguments.ts`、`src/remote/result-guidance.ts`、`src/remote/endpoint-candidates.ts`。
- 修改：`src/remote/transfer.ts`、`src/remote/exec.ts`、`src/remote/exec-tool.ts`、`src/remote/ssh-exec-backend.ts`、`src/remote/broker/client.ts`、`src/client/ssh-draft.ts`。
- 测试新增：`tests/remote-tool-arguments.spec.ts`、`tests/remote-result-guidance.spec.ts`；扩展现有 `tests/remote-tools.spec.ts`、`tests/remote-exec.spec.ts`、`tests/remote-copy.spec.ts`、`tests/client-ssh-panel.spec.tsx`。
- 文档：本计划、`docs/guide/user/ssh-remote-environments.md` 与 `.en.md`、`docs/reference/ssh-remote-environments.md`、`docs/reference/multi-environment-control-plane.md`、路线图总账与计划索引。

## 4. 退出验收

全部满足才算完成：

1. **参数面（真实注册与 dispatch）**：两个方向省略 `environmentId`、显式 `local`、附加根 `aliasId` 均完成复制；缺字段、错误类型、未知顶层/嵌套字段、`null` 与空串、非对象参数都返回 `invalid-arguments`，`message` 含字段位置，Registry 准入与 SFTP/命令 I/O 均为 0。
2. **纠错面**：端点类失败附候选；候选按登记状态、方向动作与配对过滤，`withheld` 与其他项目/无权限端点不出现；快照不可用时原错误码不变且提示退化为通用文案；`unknown`/`admitted-may-start` 提示核对状态而非重试。
3. **输出面**：默认 64 KiB 上限作用于 1 MiB 部署；`maxOutputBytes` 可放大并被部署上限夹取；恰好到线、超预算、上游已截断、跨 UTF-8 边界四种情况分别验证 `truncated`/`totalBytes`/`droppedBytes` 与文本；无坐标后端得到 `null`。
4. **既有合同不回归**：复制双准入、流式字节预算、无覆盖发布、staging 清理，以及命令取消与撤权用例全绿。
5. **门禁**：相关 Vitest、`pnpm lint`、`pnpm typecheck`、`pnpm docs:check`、`pnpm compat:check`、`pnpm pack:check` 通过；沙箱内无法复现的 Registry IPC 用例标明需宿主 CI 复验。
6. 分支推送后以 Draft PR 提交。

## 5. 证据

**本机门禁（macOS arm64 / Node 24.18.0 / pnpm 11.25.0 / DSH 0.2.2-rc.5，最终树）**

- `pnpm vitest run` 全量：**2599 passed / 213 skipped / 23 failed**（177 个文件：152 通过 / 12 失败 / 13 跳过），另有 1 条 unhandled rejection。23 个失败与既有基线逐类一致：16 条 `contended`（期望 `follower`）、2 条 `owner-without-remote-protocol`、1 条 IPC 不可达导致的错误码差异、1 条 `[]` 长度差异，另 1 条 unhandled rejection 同源；分布为 `registry*`（9）、`skills-*`（3）、`remote-exec`（2）、`remote-follower-add-timeout`（2）、`authority-boundaries`（2），以及 `b9-review-regressions`、`remote-local-transfer-admission`、`remote-personal-ops` 各 1。全部属于"Host 自身处于 DSH 沙箱、共享 Registry 的核内 IPC 按设计拒绝 sandboxed peer"，**需要非沙箱化宿主 CI 复验**。
- 与本批直接相关的 Vitest：`tests/remote-tools.spec.ts` **19/19**；`tests/remote-exec.spec.ts` **34 passed / 2 failed**（36；失败即上述两条既有 `mount` 环境用例）；`tests/remote-copy.spec.ts` **54 passed / 1 skipped**（55）；`tests/remote-tool-arguments.spec.ts` **15/15**；`tests/remote-result-guidance.spec.ts` **19/19**；`tests/ssh-exec-backend.spec.ts` **5/5**（新增适配器坐标传递用例）；`tests/client-ssh-panel.spec.tsx` 通过。关联规格 `remote-sftp`、`remote-local-source-redirect`、`local-transfer-authority`、`remote-tools-switch`、`remote-registry`、`remote-journey.e2e`、`remote-broker`、`remote-personal*` 与 `ssh-*` 全绿（除上述既有环境类）。
- `pnpm lint` 0 warning / 0 error；`pnpm typecheck` 双端通过；`pnpm docs:check` 0 error / 0 warning；`pnpm compat:check` 一致（26 个精确发布；SSH floor 5 个；allowlist / peers / 开发 pin / 安装树一致）；`pnpm build` 通过；`pnpm pack:check` **328** 个成员。
- **真实注册与 dispatch 覆盖**：经 `tests/support/remote-tools.ts` 的 Registry/Sessions/Policy/Tools 组合与 `executeTool`——两方向省略 `environmentId`、显式 `local`、附加根 `aliasId` 双方向提交；7 类结构错误对 `remote_copy`、7 类对 `remote_bash` 均返回带字段位置的 `invalid-arguments`，且 `withRemoteOperation` 未被调用、SFTP/exec 调用为 0；候选按登记状态、方向动作与配对过滤，快照不可用时保留 `endpoint-not-registered` 原码与通用提示。
- **初版输出验证**覆盖恰好到线、超预算、上游丢头、UTF-8 边界和显式调节。评审回归补充经真实 dispatch 对两路控制字符输出检验 JSON 预算，并验证 UTF-8 边界丢弃量与上游 U+FFFD 原文保留。
- **既有合同**：三方向复制、双准入、流式字节预算、无覆盖发布与 staging 清理、命令取消与撤权用例保持全绿。

**需宿主 CI 复验**：`registry*`、`skills-*`、`remote-follower-add-timeout`、`authority-boundaries`、`b9-review-regressions`、`remote-local-transfer-admission`、`remote-personal-ops` 的共享 Registry 核内 IPC 用例，以及 `remote-exec.spec.ts` 的两条 `mount` 用例——本会话 Host 自身处于 DSH 沙箱，核内 IPC 按设计拒绝 sandboxed peer。

**评审回归。** 12 份相关规格在沙箱内运行 303 条通过、1 条跳过。两条既有 `remote-exec` IPC 用例在沙箱内初始化失败，在宿主环境定向复验均通过。新增回归覆盖双向远端配对、按本地目的根权限筛选、从候选本地根重试成功、超时后的进程范围未确认、两路 JSON 输出预算，以及保留 U+FFFD 原文。UTF-8 截断用例按最终预览计算丢弃量。

## 6. 风险与后续

- `maxOutputBytes` 只截断预览，不改变远端采集器保留两倍部署上限的行为；超出预览的字节仍会被传输并丢弃，不节省网络。
- 候选读取多一次 Registry 快照（有 1 秒上限）；快照失败不会改变原错误或授权判定。
- 输出的精确计数及不确定性见[个人 SSH 技术参考](../../reference/ssh-remote-environments.md#模型工具参数结果与输出预算)。
- 后续：自动落盘与结果引用、保留执行位/mtime、显式覆盖与 `expectSha256` 条件替换、目录递归/解包，均按本批文档记录的前提另行设计，不在本 PR 内实施。
