# remote_copy 远端 staging 的流式字节预算（PR #73 Codex 评审 P2）

> 状态：**已完成——已实施并通过 PR CI 复验**（2026-11-22，分支 `feat/ssh-workspace`，reviewed commit `1c4e267`；PR [#73](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/73) `506a52f` 已合入 `main` 并随 `v0.1.24-beta.1` 发版）。本文是本轮评审修复的核验结论、实施计划与退出验收；首轮 CI 的单平台失败见 §7。
>
> 关联：PR [#73](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/73)、[ADR-0034](../../decisions/ADR-0034-binary-transfer.md)（复制阶段与字节预算）、[控制面参考](../../reference/multi-environment-control-plane.md#sftp-传输g2三个方向单文件无用户入口)、[路线图总账](../active/2026-09-12-multi-root-workspace.md#个人-ssh-外部评审后续2026-11-22)。

## 1. 评审问题

PR #73 的 Codex Review 在 reviewed commit `1c4e267` 上提出 1 条 P2（`src/remote/transfer.ts:938`）：

> 源文件在初次 `stat` 之后继续增长时，`local → remote` 与 `remote → remote` 两条上传路径都会一直读到 EOF 并把超出 `budget.maxBytes` 的字节写入远端 staging；源绑定阶段的尺寸检查只覆盖初始值，之后稳定性复检才发现 `source-changed`，此时多余字节已经落到目的端。

## 2. 核验结论（代码事实；行号按 reviewed commit `1c4e267`）

问题**成立**：

- **本地源只按初始尺寸收紧**：`openLocalSource` 在 `src/remote/transfer.ts:507` 以 `size > maxBytes` 拒绝，随后流循环（`763-772`）从已绑定的 fd 读到 EOF，不再比较累计字节数。
- **远端源同样只按初始尺寸收紧**：`RemoteSource.bind` 在 `548` 检查 `size > maxBytes`；`copyRemoteToRemote` 的循环（`928-943`）按 64 KiB 读取并直接交给 staging。
- **远端 staging 没有写入上限**：`RemoteStage.write`（`631-636`）只校验句柄与连续偏移，写入成功即累加，与 `LocalBinarySink.write`（`src/remote/local-sink.ts:244`，累计超过 `maxBytes` 抛 `transfer-too-large`）不一致。
- **反向下载不受影响**：`sftp → local` 的 `sink.write` 已按累计字节数封顶；缺口只在两条"写入远端 staging"的路径。
- **后果**：超出预算的字节先到达目的端 staging，随后才因 `source-changed`（本地 `775-779`、远端 `949-952`）或校验失败被清理。坏情况下可写满目的端暂存空间，再报告失败。

隔离复现（reviewed commit，`transfer.maxBytes = 1024`、源在绑定后增长到 4096 字节）：两条路径都先写入 4096 字节再返回 `source-changed`。

## 3. 设计

ADR-0034 的「流与校验」阶段本来就要求“按块背压，限定单文件字节数”；本缺陷是实现未兑现该合同，不是合同变更。

**单一收紧点**：让 `RemoteStage` 携带 `maxBytes`，在每次 staging 写入前比较 `this.written + data.length`；超过即以 `transfer-too-large` 拒绝。两条上传循环共用这一检查，避免在循环里复制预算逻辑。

- 错误码沿用本地 sink 已建立的 `transfer-too-large`；结果为 `failed`、`stage: "staging"`，并照常只清理本操作的 staging（`staging: "removed"`），不发布目标。
- 源增长但仍在预算内时，现有 `source-changed` 语义不变；预算内、预算边界（恰好等于 `maxBytes`）与零字节文件行为不变。
- 事故面只到 staging：检查发生在 SFTP `write` 请求之前，不产生多余的线上写入。
- 不改变 `RemoteCopyResult` 形状、准入、发布与清理顺序。

**非目标**：不新增配置项，不改变 `transfer.maxBytes` 语义与上限，不改本地 sink 与 broker 配额，不处理同秒同长改写（ADR-0030 已知限制）。

## 4. 实施

1. **红测**：在 `tests/remote-copy.spec.ts` 为两条上传路径各加一条"源在绑定后增长超过预算"的用例，断言 `transfer-too-large`、无目标、无 staging 残留，且**目的端 SFTP `write` 调用为 0**（用 `MemSftp` 的写计数证明检查发生在落盘之前）。先在未修复代码上运行，记录失败形态。
2. **修复**：`RemoteStage` 构造与 `begin` 接受 `maxBytes`；`write` 在现有连续性检查之后、发起 SFTP 写之前拒绝超限写入；两处 `begin` 调用传入 `budget.maxBytes`。
3. **文档**：控制面参考的"源/目的（远端）"两段补充"累计流式写入同样受 `maxBytes` 约束，超出即 `transfer-too-large`"；本计划记录证据；总账的个人 SSH 评审后续补一条本轮结论。

## 5. 退出验收

全部满足才算完成：

1. 两条新增回归测试在未修复树上失败（错误码为 `source-changed` 且目的端写计数大于 0），在修复后通过；测试输出归档在本文 §6。
2. `pnpm vitest run tests/remote-copy.spec.ts` 全绿（含既有的三方向、预算、超时、取消与 staging 清理用例）。
3. 关联远端规格通过：`tests/remote-sftp.spec.ts`、`tests/remote-local-source-redirect.spec.ts`、`tests/local-transfer-authority.spec.ts`、`tests/remote-tools.spec.ts` 全绿；`tests/remote-local-transfer-admission.spec.ts` 在本机沙箱内属于既有 `contended` 基线（§6），需由未沙箱化 CI 复验，不作为本改动的本机门槛。
4. `pnpm lint`、`pnpm typecheck`、`pnpm docs:check` 通过。
5. 行为断言：`maxBytes = 1024` 的部署下，绑定后增长到 4096 字节的源在两条上传路径都返回 `failed / transfer-too-large / stage: staging / staging: removed`，目的端 `write` 为 0、无目标文件、无 `.dsh-staging-` 残留。
6. 不回归：预算内增长仍为 `source-changed`；恰好等于预算的源仍提交；零字节与多块文件仍提交。

## 6. 证据

**红测（修复前，reviewed commit `1c4e267` 加新用例）**

`pnpm vitest run tests/remote-copy.spec.ts -t 'byte budget'` → **2 failed**。两条用例都返回 `code: "source-changed"`（期望 `transfer-too-large`）；临时计数显示两条路径各发生 **1 次 SFTP 写（4096 字节）**，即超限字节在失败前已经到达目的端 staging，与评审描述一致。

**绿测（修复后）**

- `pnpm vitest run tests/remote-copy.spec.ts -t 'byte budget'` → **2 passed**。
- `pnpm vitest run tests/remote-copy.spec.ts` → **52 passed | 1 skipped（53）**；跳过项是 Windows 专用分支。新增三类用例：两条上传路径的超预算增长（目的端 0 次 SFTP 写、无目标、无 staging 残留）与恰好填满预算的正例。

**关联规格**

`tests/remote-sftp.spec.ts`、`tests/remote-local-source-redirect.spec.ts`、`tests/local-transfer-authority.spec.ts`、`tests/remote-tools.spec.ts` 全绿。`tests/remote-local-transfer-admission.spec.ts` 在本机以 `contended`（期望 `follower`）失败：该规格不导入 `src/remote/transfer.ts`，失败原因是本会话的 Host 自身处于 DSH 沙箱、共享 Registry 的核内 IPC 按设计拒绝 sandboxed peer——与路线图记录的既有基线同类，不是本改动引入。

**全量**

最终树（含 exact-fit 用例）复跑：**2465 passed / 213 skipped / 23 failed**（168 个文件：143 passed / 12 failed / 13 skipped）。23 个失败全部属于既有宿主环境类：本会话的 Host 自身处于 DSH 沙箱，共享 Registry 的核内 IPC 按设计拒绝 sandboxed peer——16 条 `contended`（期望 `follower`）、6 条直接以 “the Host itself is sandboxed; shared IPC refuses sandboxed peers” 失败、1 条由同一 IPC 不可达导致的错误码差异，另含 1 条同源的 unhandled rejection。分布在 `registry*`、`authority-boundaries`、`b9-review-regressions`、`skills-*` 八个文件，加 `remote-exec`（2）、`remote-follower-add-timeout`（2）、`remote-local-transfer-admission`（1）、`remote-personal-ops`（1）——与路线图记录的既有基线同类，且均不经过 `src/remote/transfer.ts`。`tests/remote-copy.spec.ts` 在该轮为 **53 tests（52 passed / 1 skipped）**，全绿。

**门禁**

`pnpm lint` 0 warning / 0 error；`pnpm typecheck` 通过；`pnpm docs:check` 0 error / 0 warning。

**变更文件**

`src/remote/transfer.ts`（`RemoteStage` 预算收紧；本地源先按 `nlink` 分类）、`tests/remote-copy.spec.ts`（写计数与三条回归）、`tests/remote-copy-local-link-classification.spec.ts`（F_GETPATH 命名另一链接时的确定性分类）、`docs/reference/multi-environment-control-plane.md`（流式预算语义）、本计划、[路线图总账](../active/2026-09-12-multi-root-workspace.md#个人-ssh-外部评审后续2026-11-22)。

## 7. CI 首轮单平台失败（2026-11-22）

PR #73 首轮 CI [run 45011838211](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/actions/runs/45011838211) 中，28 个 verify job 有 27 个通过，唯一失败是 `verify (macos-latest, group 4, Node 22.19.0)`，失败版本 `0.2.1-alpha.4`；`gate` 因该 job 失败而连带失败。

**失败点**（既有用例，非本轮新增）：`tests/remote-copy.spec.ts > refuses symlink and multilinked sources at the bound open` 期望 `source-multilinked`，实际 `source-escapes-root`。同一 job 内其他三个版本、其余 27 个 verify job 与新增的预算用例全部通过，说明不是字节预算改动的回归。

**根因**：`openLocalSource` 先比较 `handle.canonical()` 与绑定路径、后检查 `nlink`。macOS 的 `fcntl(F_GETPATH)` 只保证返回“指向该文件的一个有效路径”；对多硬链接 vnode 可能命名任一链接（[Stack Overflow 说明](https://stackoverflow.com/questions/1406679/retrieving-the-path-from-a-file-descriptor-or-file)）。该用例的源先写成 `hard.txt` 再 `link` 成 `source.txt`，CI 内核把 canonical 报成另一链接名，于是被误分类为路径逃逸。本机内核恰好返回打开时的名字，因此本地与多数车道稳定通过——这是既有的非确定性，不是本次改动引入。

**修复**：先读 `posixFileState()` 并在 canonical 比较之前拒绝 `nlink !== 1`——多硬链接按其链接数确定性分类为 `source-multilinked`，与 F_GETPATH 命名哪个链接无关。新增 [`tests/remote-copy-local-link-classification.spec.ts`](../../../tests/remote-copy-local-link-classification.spec.ts)：mock native 句柄，令 `nlink = 2`、`canonical()` 指向另一链接；修复前得到 `source-escapes-root`（红），修复后得到 `source-multilinked`（绿）；Windows 跳过（本地传输不支持）。安全面不变：两条路径都在读取任何字节之前拒绝。

**关于重跑**：单独重跑失败项可能因内核命名差异转绿，但会保留非确定性；因此选择修掉分类顺序后推送，触发整轮矩阵复验。`gate` 不单独处理，它只汇总 verify 结果。

**复跑再次在同一车道失败（run 45018215618，`a5757c0`）**：这次是既有用例 `bounds a stalled fsync without publishing again` 报 `Error: Test timed out in 30000ms`。该用例用 40ms 的传输预算把某个 SFTP 调用替换为永不返回的 Promise，然后先 `await entered.promise` 再取结果；负载高的 runner 上 40ms 可能在插桩调用**之前**耗尽——`TransferIO.run` 在 `remaining <= 0` 时不执行 action 直接拒绝，于是 `entered` 永不落定，只能等 30s 测试超时。该用例自 `18504fe` 起如此，与本次改动无关。修复：预算提高到 1s（保证先到达调用），并改为先 `await` 传输结果、再断言被插桩方法确实被调用——预算提前耗尽会立即以明确信息失败而不是挂死；7 个方法用例逐一通过（约 1s/例）。

## 8. 风险

- 新增错误码进入结果面：已有部署若把超预算增长当作 `source-changed` 处理，需要改为识别 `transfer-too-large`；两者都是 `failed`，都不发布目标。
- 边界语义：`written + chunk.length == maxBytes` 仍允许，与 `LocalBinarySink` 一致，不改既有合同。
