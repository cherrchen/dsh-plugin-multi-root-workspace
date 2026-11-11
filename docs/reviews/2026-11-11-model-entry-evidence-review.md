# 多执行环境模型入口证据外部评审（2026-11-11）

评审日期：2026-11-11
评审人：Devin（维护者委托的外部复核）
评审基线：`feat/ssh-workspace` @ `83b76e4`；包 `0.1.17-ssh.1`；DSH `0.2.2-rc.1`；Node `24.18.0`；macOS arm64
评审方式：源码与测试静态复核；在 DSH Agent 沙箱外一次性重跑 HEAD 全量回归、冒烟与仓库门禁；登录 `.87` 做只读 unit/audit 取证，并在临时 broker 实例上复跑 F13 探针；逐项对照 2026-11-11 实机记录与截图。**没有读取凭据，没有改动生产 broker 或生产 manifest，也没有改动默认组合。**

## 结论速览

**评审结论：证据达标（PASS，针对实现与部署证据门槛）。** 本批“Linux 部署隔离、F13 配额/审计轮转/吊销、GUI 宿主、磁盘重载、其他 profile、macOS/Windows 矩阵”的证据达到[控制面参考](../reference/multi-environment-control-plane.md)设定的开门前证据门槛；代码、单测与 HEAD 回归支持实机记录中的行为结论。

**但模型入口仍默认关闭。** 本评审不构成维护者签收，也不改变任何 profile：

- 默认 `cordis.patch.yml` 不包含 `remote-tools`，也没有 `remoteEnvironments` 配置；`enabled` 未设置，语义为关闭。
- 评审通过只表示证据可以进入维护者签收；是否为某个部署启用模型可见的远端工具，仍由维护者在确认下述签收条件后决定。
- 本评审未修改默认组合、未提交或发布任何开启变更。

**部署级条件（R5）已在该部署核实：** `.87` 的唯一 profiles 目录下只有 `remote-exp` 与 `stock-exp`；两者的运行时预设表都只有 read-only/workspace-write，伪造 `danger-full-access` 均被 `remote-profile-full-access` 拒绝，没有第三个 profile，活动 Host 也没有 Agent 入口（[`remote-profile-audit-20261111.json`](../reference/remote-profile-audit-20261111.json)）。先前的 `stock-exp` 危害对照已在同一 profile 上被受限 patch 取代。维护者签收时只需确认不会新增 unrestricted profile/Agent 入口；插件仍不能替部署证明未来的 profile 集合。

## 复核基线

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | `feat/ssh-workspace` / `83b76e4` |
| 被复核证据的 HEAD | `336951d`（F13 修复）及其后的证据/文档/安装器提交 |
| 插件版本 | `0.1.17-ssh.1`（未发布、无 tag） |
| DSH / Node | `0.2.2-rc.1` / `24.18.0` |
| 本地门禁 | lint、compat、typecheck、build、docs、pack、kernel:probe、smoke:packed（136/0/0）均通过 |
| 全量回归 | **1562 passed / 131 skipped / 0 failed**（1693 tests，106 files passed / 8 skipped） |
| 冒烟 | compose **54/0/0**、behavior **137/0/0**、journey **76/0/0**；packed **136/0/0**（对打包 tarball） |
| 原始记录 | [ssh-review-20261111-vitest.json](../reference/ssh-review-20261111-vitest.json)、[ssh-review-20261111-checks.txt](../reference/ssh-review-20261111-checks.txt) |
| 实机原始产物 | [F13 受控探针](../reference/remote-f13-probe-20261111/summary.json)、[Linux unit](../reference/remote-linux-unit-evidence-20261111.txt)、[GUI 工具目录](../reference/remote-gui-model-requests-20261111.txt)、[GUI RPC](../reference/remote-gui-rpc-20261111.json)、[profile 审计](../reference/remote-profile-audit-20261111.json) |

> **测试环境说明。** DSH Agent 沙箱会让共享 Registry IPC 的对端认证拒绝沙箱内进程；在本会话沙箱内直接跑全量会出现 18 个 `contended` 失败，`pnpm registry:probe` 明说 “the Host itself is sandboxed”。这些失败是执行环境造成的，不是产品回归。上表的全量与冒烟是在一次性更宽沙箱（非 Agent 沙箱）下运行的；同一 HEAD 的沙箱内失败不纳入证据。

## 逐项复核

| 开放前事项 | 本次复核的证据 | 结论 |
| --- | --- | --- |
| Linux 部署隔离 | [`remote-entry-isolation-evidence-20261111.json`](../reference/remote-entry-isolation-evidence-20261111.json)（机器生成）；[`remote-linux-unit-evidence-20261111.txt`](../reference/remote-linux-unit-evidence-20261111.txt)；chroot 写者隔离记录 | **通过**。三个 Agent 进程入口 × `workspace-write`/`read-only` 均为 `enforcement: full`，凭据根 `EACCES`、socket `closed-no-data`；伪造完全访问由守卫拒绝；`NoNewPrivs`、`su`/`sudo`/`unshare` 均无出路。真实 `.87` unit 的 `ActiveState=active`、`PrivateTmp=yes`、socket/凭据根权限见 unit 转录（R4 已补齐）。 |
| F13 配额 | `src/remote/broker/server.ts` 的 `RollingQuota`；`src/remote/manifest.ts` 的 `quotas` schema；`remote-broker.spec.ts` 39/39、`remote-manifest.spec.ts` 42/42；`.87` 探针记录 | **通过**。env/全局窗口、按请求计操作、按 SFTP 载字节计费、拒绝先于远端动作、拒绝不计费、窗口滚动恢复均有代码与单测；实机记录给出第 4/第 7 次操作命中的具体边界。 |
| F13 审计轮转 | 同一 broker 的 `prepareAuditFile`/`rotateAudit`；`remote-broker.spec.ts` 的轮转与外来文件用例；`.87` 的 2.1MB/512B×3 记录 | **通过**。`auditMaxBytes` + `auditKeep` 链式滚动、`.1..N` 0600、拒绝外国属主/symlink 占用；实机记录与代码一致。 |
| F13 吊销 | 清单 `revocations` 双方摘要校验；`admit` 的 `environment-revoked`；`dispose` 放行；单测 revoked/unrevoked 分支 | **通过**。被吊销环境的环境绑定方法拒绝，`dispose` 可清理；`vps-xfer2` 实机拒绝而 `vps-xfer` 不受影响。 |
| GUI 宿主 | [`remote-gui-host-evidence-20261111.json`](../reference/remote-gui-host-evidence-20261111.json) 与[截图](../reference/remote-gui-host-evidence-20261111.png)；[`remote-gui-model-requests-20261111.txt`](../reference/remote-gui-model-requests-20261111.txt)、[`remote-gui-rpc-20261111.json`](../reference/remote-gui-rpc-20261111.json)、[`remote-gui-panel-final-20261111.png`](../reference/remote-gui-panel-final-20261111.png) | **通过（R3 已补齐）**。截图显示 Workspace Folders 的远端环境区块、已登记能力与本地根不受影响；原始 `TOOLS` 行给出启用/停用两态（`remote_bash`/`remote_copy` 出现与消失）；RPC 原始请求/响应给出 `addRemote`/`removeRemote` 的成功响应。 |
| 磁盘重载 | 入口探针的 `sessionReload`：经 `ctx.sessionPersistence` 落盘、`open('read')` 读回、`shared-frozen` 重放、PTY 仍受限；篡改 `sandbox/mode` 后被 `remote-profile-full-access` 拒绝 | **通过**。证明盘上状态不能洗白提权。该审计使用一个合成的 `sandbox/mode` 事件，不是完整会话生命周期；对目标威胁足够，但不覆盖真实 provider/model 事件流。 |
| 其他 profile | [`remote-profile-audit-20261111.json`](../reference/remote-profile-audit-20261111.json)：`.87` 的 `remote-exp`/`stock-exp` 运行时审计 | **通过（R5 已在该部署核实）**。两个 profile 的预设表都只有 read-only/workspace-write，伪造 `danger-full-access` 均被 `remote-profile-full-access` 拒绝；没有第三个 profile，活动 Host 无 Agent 入口。`stock-exp` 已不再是 unpatched 状态；维护者签收只需确认不新增 unrestricted profile/入口。 |
| macOS 发起端/目标 | [`remote-macos-matrix-evidence-20261111.json`](../reference/remote-macos-matrix-evidence-20261111.json)：launchd broker、`mac-local` seatbelt 目标、Linux 目标、负向拒绝、Windows 目标 fail-closed | **通过（有覆盖限制，R6）**。`install.sh` 的两处 Darwin 修复与代码一致；macOS 上未重跑受限入口探针，Electron 宿主未覆盖，原生 Windows 发起端按 ADR-0030 延后。 |
| Windows 目标 | `windows`/`win32` 在清单解析即 `windows-target-unsupported`；`freebsd` `unsupported-platform`；`remote-manifest.spec.ts` 42/42 | **通过**。整份清单失效、不触网；这是本批对 Windows 的 fail-closed 覆盖。 |
| 默认关闭姿态 | `cordis.patch.yml` 无 `remote-tools`、无 `remoteEnvironments`；`src/remote/tools.ts` 在 `enabled !== true` 时零动作；工具行需 broker 证明；`remote-tools` 只作为 `./remote-tools` export | **通过**。默认组合与 packed profile 都不含模型可见远端能力；这是刻意的。 |

## 发现与处置

| 编号 | 级别 | 发现 | 处置 |
| --- | --- | --- | --- |
| R1 | 证据一致性（已解决） | 2026-11-10 的证据清单声称全量 **1562 passed**、HEAD `336951d`，但它引用的原始报告实际是 **1545 passed** 的 11-10 报告（`startTime` 2026-11-10 06:13Z，早于 F13 提交），清单中的 `sha256` 也只对应旧报告。 | 2026-11-11 在 HEAD `83b76e4` 重跑，得到 **1562/131/0**，归档为 [`ssh-review-20261111-vitest.json`](../reference/ssh-review-20261111-vitest.json)；旧报告保留为历史。该计数现在有原始产物支撑。 |
| R2 | 已补齐 | F13 的 `.87` socket 探针脚本与原始输出、以及 `remote-broker.live` 6/6 的日志原先没有进仓库。 | 2026-11-11 在 `.87` 上用临时 broker 实例复跑配额/吊销/审计轮转（[`summary.json`](../reference/remote-f13-probe-20261111/summary.json)、[`client.json`](../reference/remote-f13-probe-20261111/client.json)、[`audit.jsonl`](../reference/remote-f13-probe-20261111/audit.jsonl)），并重跑 `remote-broker.live` 6/6（[`remote-broker-live-20261111.txt`](../reference/remote-broker-live-20261111.txt)）；生产 audit 的 quota 拒绝行见 [`production-audit-excerpt.txt`](../reference/remote-f13-probe-20261111/production-audit-excerpt.txt)。 |
| R3 | 已补齐 | GUI 证据的模型工具目录、停用态、面板 RPC 原先只有叙述；截图只覆盖登记后的面板。 | 工具目录/停用态原始 `TOOLS` 行见 [`remote-gui-model-requests-20261111.txt`](../reference/remote-gui-model-requests-20261111.txt)（生成器 [`remote-gui-scripted-model-20261111.mjs`](../reference/remote-gui-scripted-model-20261111.mjs)）；面板 RPC 的原始请求/响应见 [`remote-gui-rpc-20261111.json`](../reference/remote-gui-rpc-20261111.json)，最终面板截图 [`remote-gui-panel-final-20261111.png`](../reference/remote-gui-panel-final-20261111.png) 与文本 [`remote-gui-panel-final-20261111.txt`](../reference/remote-gui-panel-final-20261111.txt)。为了让 verifier 通过，测试 profile 临时指向本机 macOS broker（5 环境清单 `7e2c…`），随后恢复；截图中的 `mac-local` 即该清单。 |
| R4 | 已补齐 | Linux unit 的 `ActiveState=active`、`PrivateTmp=yes`、`ProtectSystem=strict` 原先只有记录；入口探针容器用 systemctl 桩，未执行真实 unit。 | 真实 `.87` unit 的 `systemctl status/show`、unit 文件、socket/凭据根/audit 权限与 journal 见 [`remote-linux-unit-evidence-20261111.txt`](../reference/remote-linux-unit-evidence-20261111.txt)；入口探针原始控制台输出见 [`remote-entry-isolation-run-20261111.txt`](../reference/remote-entry-isolation-run-20261111.txt)。入口探针容器仍用 systemctl 桩，但真实 unit 已单独取证。 |
| R5 | 已在该部署核实 | 先前的其他 profile 审计显示 `stock-exp` 可解析 `danger-full-access`；仓库不能仅凭旧记录证明部署层已禁止该 UID 下的所有无沙箱 Agent 入口。 | `.87` 的 `remote-exp`/`stock-exp` 运行时审计都只有两项受限预设、伪造完全访问被守卫拒；无第三个 profile；`stock-exp` 已不再是 unpatched 状态（[`remote-profile-audit-20261111.json`](../reference/remote-profile-audit-20261111.json)）。剩余为维护者确认不新增 unrestricted profile/入口；因此不再阻断本部署的签收，但仍阻断任何未审计的新入口。 |
| R6 | 覆盖限制（已记录） | macOS 未重跑受限入口探针、Electron 宿主未覆盖、原生 Windows 发起端延后；macOS 原始命令转录未归档。R2–R4 的原始日志已补齐。 | 这些限制已在控制面参考与 macOS 记录中声明；不改变“Linux 模型侧 profile”的结论，但不得外推为 macOS/Electron/Windows 发起端的全面验收。 |
| R7 | 流程（跟进） | 分支 HEAD 没有 CI 运行；最后一次 CI success 是 2026-11-10。 | 本地 HEAD 全量/冒烟已通过；开启前应在 HEAD 跑一次 CI（workflow_dispatch 或 PR），把 CI 结果并入签收记录。 |

**R1 的说明。** 旧清单的 1562 声称没有对应的归档报告；本次把它引用的 11-10 报告计数改回 1545（该报告本来就是 F13 之前的基线），并把 F13 之后的 1562 记录到 11-11 的新报告。两个计数都有各自的原始产物，避免用新结果覆盖历史。

## 签收边界

本评审只回答“证据是否达标”，**不代替维护者签收，也不决定何时开启**。当前应保持：

- `cordis.patch.yml`：不加入 `remote-tools` 行，不配置 `remoteEnvironments`；
- 任何部署的专用 profile：在维护者签收前保持 `remoteEnvironments.enabled` 未设置/为 `false`；
- 不把 `/tmp/f13-probe.mjs` 之类的临时探针脚本当作部署件。

维护者签收清单：

1. **R5 部署事实**：本次复核已在 `.87` 上核实 `remote-exp`/`stock-exp` 均受限、伪造完全访问被拒、无第三个 profile（[`remote-profile-audit-20261111.json`](../reference/remote-profile-audit-20261111.json)）；签收时确认不会新增 unrestricted profile/Agent 入口。
2. **逐部署证据**：确认目标部署自己的 unit、清单摘要、broker hello、配额/审计/吊销配置与本文记录一致，而不是复用 `.87` 的数字。
3. **开启方式**：只在专用 profile 的 patch 中加入 `remoteEnvironments.enabled: true`、`manifestPath` 和 `remote-tools` 行；默认包与默认 profile 不动。
4. **回滚**：按控制面参考的停用/回滚步骤先撤工具行、再撤 `remoteEnvironments`、再停 broker；保留本地根与历史记录。
5. **记录**：在路线图总账记录签收日期、部署标识、清单摘要和开启/回滚决定。评审通过不是开启授权。

## 维护者签收（待人工）

本评审不代签。维护者确认后填写：

- [ ] R5 部署事实已复核（`.87` 的 `remote-exp`/`stock-exp` 均受限、无第三个 profile；确认不新增 unrestricted 入口）
- [ ] 目标部署自己的 unit、清单摘要、配额/审计/吊销证据已核对
- [ ] 已决定为该部署开启，或继续保持关闭
- 签收人：__________　日期：__________　部署标识：__________
- 开启时只修改该部署的专用 profile；默认 `cordis.patch.yml` 不变。

## 复核产物

- 全量原始报告：[`ssh-review-20261111-vitest.json`](../reference/ssh-review-20261111-vitest.json)（sha256 `dd9e9670…25b3`）
- 复核命令与结果：[`ssh-review-20261111-checks.txt`](../reference/ssh-review-20261111-checks.txt)
- 机器可读摘要：[`ssh-review-20261111-evidence.json`](../reference/ssh-review-20261111-evidence.json)
- 历史基线：[`ssh-review-20261110-evidence.json`](../reference/ssh-review-20261110-evidence.json)、[`ssh-review-20261110-vitest.json`](../reference/ssh-review-20261110-vitest.json)
- F13 受控探针：[`summary.json`](../reference/remote-f13-probe-20261111/summary.json)、[`client.json`](../reference/remote-f13-probe-20261111/client.json)、[`audit.jsonl`](../reference/remote-f13-probe-20261111/audit.jsonl)、[`production-audit-excerpt.txt`](../reference/remote-f13-probe-20261111/production-audit-excerpt.txt)、[`live 配置`](../reference/remote-broker-live-config-20261111.json)
- 真实 unit 与入口探针：[`remote-linux-unit-evidence-20261111.txt`](../reference/remote-linux-unit-evidence-20261111.txt)、[`remote-entry-isolation-run-20261111.txt`](../reference/remote-entry-isolation-run-20261111.txt)、[`profile patch`](../reference/remote-exp-patch-20261111.yml)
- GUI：[`remote-gui-model-requests-20261111.txt`](../reference/remote-gui-model-requests-20261111.txt)、[`remote-gui-rpc-20261111.json`](../reference/remote-gui-rpc-20261111.json)、[`remote-gui-panel-final-20261111.png`](../reference/remote-gui-panel-final-20261111.png)
- R5 运行时审计：[`remote-profile-audit-20261111.json`](../reference/remote-profile-audit-20261111.json)

本评审未修改产品代码、默认 patch、版本号或生产部署配置。GUI 测试 profile 为抓取 RPC 临时指向本机 macOS broker，随后已恢复；`.87` 的一次性 F13 临时 broker/清单在取证后已清理。
