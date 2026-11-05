# 根授权安全修复计划：BYP-01、MRW-01、BYP-02、DSH_HOME 与默认权威

## Status

**Accepted（已接受）**。2026-11-05 经维护者明确接受，纳入本轮审核补充。目录归属：`docs/plans/active/`；接受的是修复范围、阶段与验收合同，不表示已实施、已修复或已发布。实施进展：P0 静态证据已记录（见下文“P0 记录”，选型待评审），P1 已实施（[ADR-0027](../../decisions/ADR-0027-revive-target-and-protected-paths.md)）；验证状态以路线总账为准。下文“Current State”保留计划接受时的基线描述。

日期：2026-11-05。实施批次已登记[路线进度总账](./2026-09-12-multi-root-workspace.md#进度总账)。后续实施遵循本文 P0 前置验证及阶段依赖；可信确认能力、跨 Host 能力传递、origin 持久绑定与迁移的具体合同仍须经验证和评审，不能以计划已接受代替技术证据。本次只更新计划与登记状态，不修改运行时代码、提升上游支持版本或发布；涉及现有 Accepted ADR 的语义变化须在实施时显式修订或以新 ADR 替代，保留历史决定。发布内容仍归 CHANGELOG 双语对。

## Goal

堵住两类授权跳跃：远程请求自行改变根授权，以及路径重新解析使既有授权/负授权被替换或遗失。同时补齐 `$DSH_HOME` 的登记边界和 Registry 缺席时的保守默认值。

所有拟议修复保持 out-of-tree，不修改任何上游包。审批能力、路径身份或内核能力不足时明确拒绝，不以 ambient Full-access 或默认成功补偿。

## Background 与核实范围

- 核实基线：当前 HEAD `306d65a`，插件 `v0.1.14`；本地已安装开发树 DSH `0.2.2-rc.1`、Cordis `4.1.0`，Node `v24.18.0`，macOS。
- 方法：独立检查插件 `src/`、已安装上游构建产物/类型，以及既有 ADR。**本次没有执行端到端攻击、发送伪造 RPC、读取真实凭据内容或进行 Linux/Windows 原生利用验证。**“成立”指静态机制与调用链成立，不等于跨平台 exploit 已执行成功。
- 输入材料：[现有外部报告核查](../../reviews/2026-11-05-external-security-report-verification.md)。该文件在本次工作开始前已存在于未跟踪目录，本文不修改它；以下结论以当前源码独立复核为准。未重新读取邮件和附件原件，不为其原文或原始评级背书。
- 当前合同：[登记与校验 ADR-0004](../../decisions/ADR-0004-root-registry-persistence-and-validation.md)、[面板 session 权威 ADR-0008](../../decisions/ADR-0008-panel-session-derived-authority.md)、[Session origin ADR-0012](../../decisions/ADR-0012-session-origin-and-effective-cwd.md)、[三态矩阵 ADR-0017](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)、[操作准入 ADR-0024](../../decisions/ADR-0024-registry-operation-admission.md)、[共享权威 ADR-0025](../../decisions/ADR-0025-shared-registry-authority.md)。

## Current State：逐项核实

行号属于上述 HEAD，实施时以符号重新定位。上游位置采用 `包名@版本 / 制品:行号`，避免把本机 pnpm 物理目录写成长期链接。

| 项目 | 核实结论 | 当前证据与触发条件 |
| --- | --- | --- |
| BYP-01：根变更无审批 | **成立；邮件 Critical 评级需注明利用前提** | [command.ts](../../../src/command.ts) 的 `apply`（220–221）、`runCommand`（244–284）、`dispatchPanelRequest`（624–705）均直接调用 Registry mutation；[registry.ts](../../../src/registry.ts) 的 `add`、`setAccess`、`removeAt` 等没有人工授权闸门。上游 RPC 第四参 `peer` 未被接收。 |
| MRW-01：主根换名清空 Full-access deny | **静态机制成立；Linux 原生重现待补** | [scope.ts](../../../src/scope.ts) 的 `project`（547–578）现算 `canonicalPath(policy.workspaceRoot)` 再查 `rootsByPrimary`；[registry.ts](../../../src/registry.ts) 的 mutation、snapshot、admission 也重复 canonicalize。主根换名、原拼写变为 symlink 后新 key 可命中空表，旧 deny 和 `protectedHome` 随之消失。 |
| BYP-02：revive 重新授权 | **成立** | [registry.ts](../../../src/registry.ts) 的 `add`（668–727）以当前解析目标匹配 withheld 行，再以 `grantFields(..., canonical)` 重写 grant；[WorkspaceFoldersAction.tsx](../../../src/client/WorkspaceFoldersAction.tsx) 的 `reRegister`（495–497）单击发 `add({ path })`，没有授权确认。 |
| `$DSH_HOME` 边界缺失 | **成立** | [roots.ts](../../../src/roots.ts) 的 `RootCandidateContext`、`validateRootCandidate`（281、315 起）没有 `dshHome` 边界；[scope.ts](../../../src/scope.ts) 的 `protectedHome` 只在 Full-access 有 deny 或 authority unavailable 时生效。workspace-write 可登记不与主根重叠的 home 本身、祖先或后代，继而获得写权限。 |
| `registryAuthority` 默认 available | **部分成立：真实默认值缺口，触发面受限** | [scope.ts](../../../src/scope.ts):349 默认为 `available`。Registry 构造后会先置 unavailable（[registry.ts](../../../src/registry.ts):385），正常启动顺序已有保护；缺口是 Registry 因 inject 前置缺失而从未构造，scope/fs/sandbox 仍存活，Full-access 信任空 deny。 |

### BYP-01 两条入口与 cookie 链

1. 面板：`/multi-root-workspace` → `dispatchPanelRequest` → `registry.*`。`dsh-client-connection@0.2.2-rc.1 / lib/index.js:910` 明确调用 `handler(endpoint, payload, signal, peer)`；插件只收前三参。
2. 命令：Typert `commands/execute` → `runCommand` → 同一 Registry。`dsh-commands@0.2.2-rc.1 / lib/typert.host.js:64` 暴露该 Remote；当前 wire 的上下文是 `agentId`，不能把旧版本的 session 参数调用样例原样当作本版本 PoC。`lib/types/index.d.ts:19–35` 的 `CommandInvocation` 只有 commandId、agent、rawInput、attachments、signal，没有 peer/principal；命令代码不能凭文本或 `source: user` 证明是真人输入。

五个前提均能从当前本地制品/源码复核：

| 环节 | 代码事实 | 证据 |
| --- | --- | --- |
| 凭据落盘 | browser 签名 secret 经 credentials provider 持久化；local provider 使用 `$DSH_HOME/.credentials.yaml`，0600 防其他用户，不能隔离同用户 agent | `dsh-client-connection / lib/index.js` 的 `initializeSecret`、`BrowserAuth.create`；`dsh-credentials-local / lib/index.js` 的文件路径与权限校验 |
| 环境可知 | agent shell 获得 `DSH_HOME`、`DSH_SESSION_ID` | `dsh-shell-env / lib/index.js:86–89` |
| HTTP 认证 | 无 Origin 的受信 loopback Host 可过 Host/Origin fence；v1 cookie 为 HMAC-SHA256 签名，验证通过映射到 owner browserPeer | `dsh-client-connection / lib/index.js:240–249、352–388、545–575、714–746` |
| 网络可达前提 | 当前 bwrap 基础参数有 `--unshare-pid`，没有 `--unshare-net`；参数中没有网络隔离不等于已验证每个部署的 loopback 可达 | `dsh-sandbox-local / lib/index.js` 的 bwrap profile 构造 |
| 授权落点 | 候选校验没有 `$DSH_HOME` 禁区；不与主根/既有根重叠的敏感目录可登记 | 插件 `validateRootCandidate` |

所以只接收 `peer` 并检查 `principal.kind === 'owner'` 挡不住这条链：有效伪造 v1 cookie 同样得到 owner。仅检查 Origin、UI 增加确认框、或让同一 cookie 可取得并提交一个 nonce，也不能证明真人意图。敏感信息仍沿用上游读取模型；禁止 home 写入本身不阻止读取 secret。

### MRW-01 的边界

- Full-access 下存在只读根或工具 cap 等负授权时，换 key 会把“查不到记录”误当成“已证明无约束”。workspace-write 下丢失附加根通常是可用性损失，不能据此宣称 ambient 越权；其主根身份漂移仍需拒绝跟随。
- [dialects.ts](../../../src/dialects.ts) 的 `restrictProfileArgs`（512 起）只 pin denied roots 的祖先，没有独立 pin Session origin。主根如果已落在这些 mountpoint/保护对象上，报告中的 rename 会失败；**可利用布局需要主根未被既有 pin 覆盖**。原生测试必须包含该布局与不可换名的对照。
- shared admission 没有提供独立的稳定身份：重新解析后仍可能用漂移 key 取得自洽的空 snapshot。只修 `scope.project()` 一处不够。

### BYP-02 的展示事实修正

`classifyStoredRoot` 已在 `detail` 写入新旧目标，面板以 `title={root.detail}` 放到警告 tooltip（`WorkspaceFoldersAction.tsx:665`）。因此不能断言“完全不显示新目标”。真实缺口是：没有强制呈现新旧 canonical 对照并确认，mutation 也没有绑定用户所见目标；单击会把旧 access 迁移到新目标。

同路径目录消失后恢复属于既有路径授权模型；本文不把 canonical 字符串相等夸大为 inode 身份认证，也不声称解决所有同名目录替换或文件 I/O TOCTOU。

## Scope 与 Non-goals

拟覆盖上述五项、两条远程入口、直接 Registry 调用以及共享 owner/follower 的最终提交路径。新增授权语义必须同时覆盖 fs、sandbox、shell/PTC/agent PTY 和其他 scope 消费者。

本计划不处理外部报告中的 POSIX hardlink、通用文件 TOCTOU、未包装的任意宿主 spawn、PTY marker 设计、供应链评级或 lease unlink/recreate 的完整修复。也不承诺撤回已启动进程/PTY 的内核快照。纯 Full-access 无根限制时是否永久保护 home 是另一项产品策略，不能在本次文档中宣称已采纳。

## Design（已接受的目标合同，尚未实现）

### F1：Registry 提交层的根变更授权

**首版统一保护所有持久化根管理变更**，避免依赖当前 Session mode 判断持久策略是否扩权。保护点必须位于 Registry facade 到 owner 最终提交的共同路径，不能只包 panel handler 或只包命令 parser。

| 操作 | 首版要求 | 原因 |
| --- | --- | --- |
| 新 add、任何 revive | 对精确目录与策略取得一次真实人工授权 | add 还引入 membership、instructions、Skills 等影响，不能只按写权限判断 |
| setAccess（真实变化） | 人工授权绑定旧/新 access 和同一 recorded boundary | inherit 与 read-write 跨模式不构成全序，不能只检查当前模式下的“升级” |
| remove / removeAt | 人工授权绑定被删除的精确条目 | Full-access 下删除 read-only 条目会撤掉 deny；cap 下删除条目也可能恢复 ambient 写入，绝非总是收窄 |
| setSkillsEnabled、setAliasId、setAlias、move | 首版同一管理授权机制；以后若要豁免纯展示变更，另行证明并评审 | 不留未鉴别的管理写入口；Skills 开关与命名有执行上下文影响 |
| recheck | 纳入同一 prepare/确认/commit 管理授权，覆盖直接调用与共享 IPC | 当前 `recheck()` 会重分类并调用 `persist()`，不能按只读 refresh 豁免；确认绑定实际持久差异，提交时重新校验 |
| list / refresh / reveal、既有同值 no-op | 不产生新授权；读取/展示沿用现有会话校验 | refresh 只重分类、不写盘、不隐式 revive |

启动时 Skills migration 是内部维护写，不是假定存在真人的管理调用：须列出允许的 schema/metadata 差异并证明不新增根、不改 grant 边界/access、不扩大 Skills 的有效启用范围；不满足此证明则保留记录并 withheld，等待可信管理确认。迁移不得复用免审批的通用 mutation 入口。P0 审核当前 `migrateRootSkills()` 与启动 `table.put()` 路径；测试覆盖旧记录、重复启动、失败及 owner 接管。`recheck` 不享有该内部维护例外；同值 no-op 豁免仅限确认无持久变化且不调用 persist 的路径。

采用 prepare → 确认 → commit，而非持有 store 队列等待用户：

1. 在 owner 的现有 store-wide 队列内重分类和验证，产生精确变更提案；绑定 store、authority epoch、可信 Session origin、条目身份、旧 grant、新 canonical 目标、access/Skills 等实际变更、publication revision 和随机一次性 ID。
2. 释放队列，在具备可信人工确认能力的 Host 上显示完整提案；限制挂起数量、有效期，响应 abort/断线/卸载。展示字符串不作为授权证据。
3. 再进入同一队列，从持久记录重新读取、重分类、校验路径与 home 边界；仅当提案相关状态和目标仍匹配时消费一次授权并持久化/发布。等待期间已有任何相关变更或目标漂移则拒绝，并要求重新确认；不复用旧 snapshot 做 read → validate → persist。
4. 明确取消与提交的分界：owner 在队列内完成最终校验、检查取消/有效期/epoch 并一次性消费授权后，进入不可保证取消的持久化提交阶段；此前已观察到的拒绝、取消、超时、服务缺席或 epoch 改变保证不写盘、不新增 grant。进入提交阶段后，abort、断线或应答超时不能承诺“未写入”：owner 可能已落盘并发布。此时调用方报告“结果不明”，按 ADR-0025 refresh 对账，不自动重放、不自动回滚；不能把结果不明显示成已取消。存储自身返回 unknown-state 时沿用隔离至重启和对账规则，不把不确定写入当成功发布。日志记录精确变更、提交阶段与结果，不记录 cookie/secret 或可复用凭证。

**审批能力需要先做最小验证，当前不能视为已解决：**

- `dsh-user-approval@0.2.2-rc.1 / lib/index.js:153–168` 的 `approval.request()` 要求 session 有 open turn；命令在 turn 外记录生命周期，面板也可在空闲时使用。不能直接在 `registry.add` 调它就宣称完成；不能伪造 turn 事件、调用私有 `decide` 或临时改变 approval policy 绕过约束。应验证公开的交互/审计接缝；不具备时拒绝变更。
- 上游 `approval/request` 通过 `dsh-api-remotes / lib/index.js` 作为 waterfall 转发，UI answerer 通过 `ctx.remote.$on('approval/request', ...)` 回答。现有机制本身不能直接证明答案来自真人。必须检查回答通道是否仍依赖同一可伪造 owner cookie；`allowed-once`、随机 request ID、owner peer 均不是独立证明。
- 推荐采用**不经该 HTTP cookie 通道自我批准的宿主本地确认能力**，例如经核实的本地终端/原生交互。Web 可提交请求，但不能凭同一 cookie 领取或完成授权。若现有公开接口无法提供这种能力，先禁止该环境中的根管理写操作，并明确报告能力缺失；不能以浏览器二次点击作为安全替代。
- 首版不接受 Auto Review、会话“永不询问”策略、model/source 标签、客户端 `approved: true` 或可被同一通道领取的 bearer nonce 代替真实确认。`ctx.approval` 只有在公开生命周期和 answerer 信任都验证后才能复用。
- 直接调用 `registry.*` 也要有可信管理上下文，不能留 `skipApproval`、缺 Session 即免审等生产旁路。测试/冒烟用受控确认 fixture；既有 `setAdditionalRoots()` 仍只作为内部 scope 发布口，不新建根数据源。
- follower 提交不能携带客户端自报的“已批准”位。确认结果须由 owner 可核验的受信 Host 能力产生，绑定 native IPC 身份与该提案；同进程可使用不可由 JSON 构造的能力。owner 本地与 follower 管理调用须走同一最终校验。具体能力传递合同须先评审，不能把“内核认证了 Host”误作“Host 上每次 HTTP 调用都是真人”。

面板应接收第四参 peer，校验管理 caller 资格并记录来源；这属于纵深防御。CommandInvocation 没有 peer 时，不按 `rawInput` 猜测真人。两入口最终均依赖上述 Registry 授权合同。

### F2：revive 不改变 grant 目标

- 就地恢复只允许当前 canonical 目标与该条目**唯一的既有 grant 字段**相等，并通过新校验；比较同时覆盖 inherit、read-only、read-write 三种编码，不只看 `recordedPath`。
- redirected 条目不能再由 `add(oldPath)` 按旧 access 自动改写到新目标。即使 F1 已经有审批，也保留这一明确 API 边界。
- 若用户确实要替换目标，走“移除旧登记 + 新增新目标”的显式管理流程，分别受 F1 保护，确认中强制显示旧边界、当前目标与新 access。移除本身可能撤销 deny；若新增失败，应显示旧限制已删除/新根未建立的真实状态，不宣称原子替换或自动重试。
- 面板对 redirected 行移除“单击恢复到任意当前目标”的行为；同目标 missing 恢复与 redirected 替换分开表达。取消不写盘，不把 hover tooltip 当确认。

### F3：Session origin 的稳定授权身份

- 将“可信 origin 的登记 key”与“现在该路径解析到哪里”分开；在 agent 执行前建立绑定，之后解析只用于检查是否仍指向被接受的路径，不能选择另一组 Registry 记录。
- 统一检查面板 `resolvePanelPrimaryRoot`、命令 policy、Registry mutation/refresh/captureSnapshot/admit、scope resolve/membersOf/setAdditionalRoots、IPC primary 及各消费入口。不能只固定展示 key，执行侧继续动态 canonicalize。
- 主根 missing/redirected/无法证明原始绑定时，authority 对该操作为 unknown/unavailable，保留旧负边界；不得把新 key 的空表解释成“健康空 Registry”。也不得把新目标当作 unavailable 的“主根 fallback”授予写入：只有身份仍能证明的原主根可用 fallback，否则拒写/拒绝新进程启动。
- 基于 ADR-0012，effective cwd / Worktree 目录变化不能改变 origin。首次正常以 symlink 打开项目可解析一次并固定目标，后续替换不能跟随。
- resume、Host 重启、多个 Session 共用 origin 以及只有 policy 没有 Session 的直接调用都须有明确身份合同。若现有 header/store 不能保留绑定，需设计最小的可持久化 origin 绑定与保守迁移；不能仅靠进程内首次 realpath 缓存声称跨重启修复，也不能根据新路径扫描猜测属于哪份旧授权。
- 支持的方言可补 origin/祖先 pin 作纵深防御；pin effective cwd 或只给 bwrap 加 self-bind 不能替代稳定 key 与所有入口的身份校验。不可表达的场景明确拒绝，保留同步/异步 API 形状。

### F4：`$DSH_HOME` 与 Registry 物理介质的登记和执行边界

- 从可信 Host 配置得到与 scope 同源的 home 边界，传入候选和存量记录校验；不得相信面板传来的 home 或 shell env 的自报值。需定义 home 本身 missing/symlink/改名时的稳定身份与失败规则，不能每次跟随替换目标产生新保护边界。
- 保护集合不仅包含 home，还包含 Registry 实际使用的 canonical 存储介质目录及 lease 所在目录：当前允许自定义 `sharedStorageRoot`，且默认 `storages` 子目录也可能通过 symlink 指向 home 外。从 owner 的可信配置和物理介质绑定导出这些边界，与快照/执行侧同步；旧组合须确认其实际 storage domain 介质。无法证明物理落点时拒绝新增授权，受限执行保守拒绝，不能仅保护路径拼写。不得信任客户端提交的介质路径；介质或 lease 身份变化时按同一稳定身份与失败规则处理。
- 以下候选拒绝、存量 withheld、负边界保留和执行 deny 规则均逐一应用于保护集合的每个目录，包含 home 外的介质及 lease 目录；保护整个目录，避免通过替换 JSON/lease 文件绕过。不同 Host 的保护边界不能仅取各自 home 而漏掉 owner 的共享介质。纯 ambient Full-access 的范围排除同样适用于该集合，不扩大本期保证。
- 所有模式、所有 access 的新 add/revive，拒绝 canonical 候选与 home **相等、包含 home、位于 home 内**的情况，含 symlink 别名；不是只拦 `candidate === home`。首版不设可经远程打开的豁免。
- 存量危险记录在读取/refresh/owner snapshot 时 withheld 并说明原因，不删除、不自动重授。不能简单降为会丢掉可信负边界的通用 invalid；需要保留原 read-only/cap 拒绝信息，兼容 reserved-boundary 和 membership-conflict 规则。
- workspace-write/read-only 的有效 grant（含主根、显式附加根、平台共享 temp）若覆盖 home，写入 deny 必须优先；home 与主根嵌套时仍 deny 优先。对已有受限 Full-access 沿用并强化 home 保护。只在 UI/登记入口拒绝不够，旧 store 与主根/temp 重叠也须覆盖。
- fs write/edit/patch/delete/move 两端和全部受限进程统一消费该边界；方言无法做子树减法则拒绝启动，不能静默删掉 deny。必须验证 rootless 且 home 不重叠的健康组合仍符合原空根 parity。
- 这不建立 home 读取 ACL，不宣称单独堵住 cookie 伪造链；纯 ambient Full-access 无限制场景的 home/lease 防篡改不在本期完成承诺中。

### F5：未知 authority 不等于已证明空表

- scope 初始为 `unavailable`；只有 Registry 完成可信存储读取/发布，或 follower 完成所需快照同步后才能置 available。无 Registry 不再自动等于无持久限制。
- 保留 `setRegistryAuthority()` 的幂等通知，不恢复 Issue #24 的重复通知循环；失败与 teardown 继续保留负边界。
- **保持 provider gate 例外**：fs/sandbox 不新增 `multiRootCompat`/Registry 硬注入，`permissionPresets/catalog` 等基础服务仍需可用。Registry 缺席时由 scope 保守行为收窄，不能让整个 profile 死掉。
- 这会收窄“拒绝兼容 gate 或缺 Registry 时 Full-access 与未安装插件完全一致”的旧承诺，是本计划接受的目标安全语义变化（尚未实现）。需与 ADR-0009、ADR-0017 明确协调，不能一边改默认值一边声称所有退化路径保持 byte-identical。健康 Registry 已证明空表的正常组合仍应 upstream-exact；裸 scope/provider 测试应显式建立所需 authority fixture。

## Implementation：阶段与依赖

计划已接受；各阶段执行状态与发布状态以[路线进度总账](./2026-09-12-multi-root-workspace.md#进度总账)为准，不指定发布版本。P0 未满足前，不得把依赖它的技术选择视为已验证。

| 阶段 | 工作 | 完成证据 |
| --- | --- | --- |
| P0：合同与最小验证 | 证明 turn 外管理确认的公开接口、确认通道的独立信任、跨 Host 能力传递；选定 origin 持久绑定/迁移和 gate 退化语义，核实物理介质保护集合、提交分界及内部迁移例外 | 评审记录与针对性实验。未证明可信确认前不得声称 BYP-01 已修复 |
| P1：先阻止隐式重授 | F2 + F4 完整保护集合的候选/存量校验，补三种 grant 与 home/外置介质布局回归 | 两入口及直接 Registry 均拒新目标/危险根，旧 deny 不丢失 |
| P2：完整管理授权 | F1 prepare/commit、受信确认、取消/审计、owner/follower；同步改面板交互 | 两条 cookie 调用路径和直接调用均无法自行授权，真实确认仍可完成合法操作 |
| P3：身份与默认值 | F3 全链路稳定 origin、F5 初始 unavailable、F4 统一执行 deny；修相关消费方 | 主根置换、依赖缺席、恢复/重启与原生方言矩阵 |
| P4：联合验收与文档 | 真实制品双入口攻击回归、兼容/平台门禁、用户指南/ADR 更新 | 全部门禁及未运行项如实记入既有路线总账；再决定发布流程 |

P1 可作为先行缓解，但不等于 BYP-01、MRW-01 修完；F2 的显式删除/新增流程依赖 P2 才能作为安全替换入口。P3 的安全主根 fallback 依赖稳定身份，不能先仅改 unavailable 就宣称 MRW-01 解决。

### P0 记录（2026-11-05，静态证据；未做针对性实验）

基线同上（`0.2.2-rc.1` 开发树，macOS）。以下只核对已安装上游制品与插件源码，**没有运行攻击、伪造请求或原生实验**；“结论”是静态结论，标为“待评审”的项必须经维护者选定后才能进入 P2/P3。

| P0 问题 | 静态结论 | 证据 |
| --- | --- | --- |
| turn 外管理确认的公开接口 | **不存在可直接复用的接口**。`approval.request()` 在 session 无 open turn 时直接抛错，面板空闲与 turn 外命令都不满足；`ctx.authorization` 只服务凭据获取流程，由发起它的同一 surface 回答提示 | `dsh-user-approval@0.2.2-rc.1 / lib/index.js` 的 `request()`；`dsh-authorization / lib/types/index.d.ts` 的 `AuthorizationSession.prompt` |
| 确认通道是否独立于 owner cookie | **不独立**。`approval/request` 由 `dsh-api-remotes` 以 waterfall 转发给远程事件源；`Principal` 在该版本只有 `kind: 'owner'`，有效浏览器 cookie 一律映射为共享的 `browserPeer`（owner，`interactions: 'answer'`），因此伪造 cookie 同样能领取并回答审批。ACP / JSON-RPC SDK 回答者同为远程 owner 通道 | `dsh-api-remotes / lib/index.js` 的 `API_REMOTE_FORWARDED_EVENTS`、`forwardWaterfall`；`dsh-client-connection / lib/index.js` 的 `HostConnectionService.admit`、`Peer`；`dsh-typert-protocol / lib/types/types.d.ts` 的 `PrincipalMap` |
| 宿主本地交互能力 | 上游只有 web GUI 组合的 `directoryPicker` native 能力（在 Host 显示器上打开 OS 目录选择器），能证明“谁在本机选了哪个目录”，但不能表达 access 变化、删除或 Skills 开关的确认，headless/远程组合也没有。没有通用的原生确认对话框 | `dsh-host-directory-picker / lib/types/index.d.ts` 的 `DirectoryPickerNativeCapability` |
| 跨 Host 能力传递 | 共享 IPC 只证明“对端是同 uid、未受沙箱的 Host 进程”（darwin 拒绝 `sandbox_check` 非零的 peer，Linux 拒绝 `NoNewPrivs` 非 0），不携带每次调用的人工证据，不能作为“已确认”位 | `src/authority/native.ts` 的 `authenticate` |
| origin 持久绑定 | `SessionHeader` 只保留创建时的**词法** `cwd`，没有扩展字段；`SandboxExecutionPolicy` 可带可选 `sessionId`，但“只有 policy 的直接调用”不一定有。现状下所有入口都对 `workspaceRoot` 现算 `canonicalPath` 作为 Registry key | `dsh-session / lib/types/types.d.ts` 的 `SessionHeader`、`CreateSessionOptions.meta`；`dsh-sandbox / lib/types/index.d.ts` |
| 物理介质保护集合 | 默认组合启用 `sharedStorageRoot`，介质由 `storeIdentity()` 以 `realpathSync.native` 解析，可证明物理落点（含 `storages` 指向 home 外的 symlink），lease 必须与介质同一目录。**legacy 组合**（无 `sharedStorageRoot`）经 `ctx.storageDomain.open()` 打开，上游公开接口不暴露 storage-json 的 `root`，只能依据 ADR-0007 的“lease 与 JSON 文档同目录”配置合同推定 | `src/registry.ts` 的 `ensureAuthority`；`src/authority/native.ts` 的 `storeIdentity`；`dsh-storage-json / lib/types/index.d.ts` |
| 启动 Skills migration | **不满足**拟议的内部维护例外：`migrateRootSkills()` 给缺字段的 legacy 非只读行补 `skillsEnabled: true`，把“元数据缺失 → Skills withheld”变为启用，扩大了 Skills 的有效启用范围；且 `persist()` 在**每次** mutation（含 `recheck`）都重跑迁移 | `src/skills/metadata.ts` 的 `migrateRootSkills`；`src/registry.ts` 的 `openDomain`、`persist` |
| `recheck` 的持久差异 | 写回重分类结果：available/missing 行的 `path` 改写为当前 canonical（redirected 行保留登记拼写），grant 字段不变，并附带上述迁移。确认合同须绑定这些实际差异 | `src/registry.ts` 的 `recheck`、`toPersistedRoot` |
| 提交分界 | 现有 `persist()` 先落盘后发布；共享 follower 的 mutation 不重放丢失应答，已有“结果不明”雏形，但没有“确认消费点”这一概念 | `src/registry.ts` 的 `persist`、`refresh` 注释 |

由此得出、**待维护者评审**的选型：

1. **可信确认（P2 前置）**：上游无可用接缝，标准 Web approval 不能作为证据。候选方案是“Web 只提交提案，人工在本机终端用插件自带 CLI 经共享 IPC 确认”——IPC 已拒绝受沙箱 peer，因此受限的 agent 进程（workspace-write、或受限 Full-access 的 Seatbelt/bwrap 前缀）无法自我确认，纯 ambient Full-access 仍不在保证范围内。Windows 的 peer 判定、headless 组合与 legacy（无共享 IPC）组合需要单独结论；在评审通过前，备选缓解是对远程入口禁止根管理写。
2. **origin 绑定（P3 前置）**：候选方案是在插件自有 storage domain 中按“词法 origin → 首次观察到的 canonical key”持久绑定，后续解析与绑定不一致即视为 unknown，保留旧负边界；升级前已被置换的布局无法追溯识别，不按新路径猜测。
3. **legacy 介质**：P1 按 ADR-0007 配置合同把 lease 目录当作 legacy 介质目录保护，并在 ADR 中记录这一推定；若评审要求严格“无法证明即拒绝”，则 legacy 组合应拒绝全部新增登记。
4. **Skills migration**：P2 需要把补 `skillsEnabled: true` 改为保持 withheld，待可信管理确认后启用，并把迁移从通用 `persist()` 中拆出；这会改变 ADR-0023 的 legacy 默认值。

## Validation（拟执行，本文未执行）

仅在隔离 fixture `$DSH_HOME`、临时凭据、临时主根/额外根和本地测试 Host 中验证，断言实际字节、持久记录、scope/profile 与结果；不得使用日用凭据或配置。Linux 放置主根于 denied-root 祖先 pin 之外；负面目标同时放在主根/平台 temp 授权范围外，防止测试假阳性。

| 场景 | 必须验证的结果 |
| --- | --- |
| 面板 POST + 真实 Typert commands/execute | 在测试 Host 上生成/使用可被接受的 owner cookie，无可信确认时 add/access/remove 均无持久变更或新 grant；请求成功认证不等于管理授权 |
| 审批自我回答 | 同 cookie 领取请求、提交答案、获取 nonce、伪造 approved 字段、非 owner peer 均不能授权；真人可信确认可完成精确变更 |
| 生命周期 | 空闲面板、turn 外命令、活动 turn、ask/never、Auto Review、无 answerer/headless、abort/超时/服务卸载都有明确结果；无能力时拒绝，不能让命令挂死 |
| mutation 全覆盖 | add/revive、setAccess 所有方向、remove/removeAt、recheck、Skills 与元数据操作；同值 no-op 不调用 persist；启动 Skills migration 仅允许经证明的内部维护差异；直接 Registry 与 follower 调用；删除 Full-access read-only/受 cap 根须被保护 |
| 审批期间并发 | 相同/不同 root 重排、条目变化、symlink 换目标、owner 接管、epoch/revision 改变、双击与 nonce 重放；拒陈旧提案，不阻塞其他 admission/撤权，不重放结果不明 mutation |
| 提交分界与结果不明 | 用确定性屏障验证提交前取消无写入；持久化成功后丢应答、提交中超时/断线均报告结果不明，refresh 可看到已提交结果，无重复提交或自动回滚；存储 unknown-state 隔离至重启 |
| revive | missing 同目标、redirected 指向普通外部目录或 home；三种 grant 编码、超限存量、混合 invalid/重复 ID；未确认新目标绝不继承旧 access，取消字节不变 |
| 主根置换 | rename + symlink、直接 symlink retarget、消失、操作中更换；本地/共享、面板/命令/新 fs/新进程/PTY/LSP/Files；deny 与 protectedHome 不因 key miss 清空，不对替换目标发主根 grant |
| 身份生命周期 | 首次 symlink 项目、正常 effective cwd/Worktree 切换、resume/Host 重启、多个 Session、只有 policy 的直接调用；正常切 cwd 不变 key，无法证明旧 origin 时拒绝猜测 |
| home 边界 | 本身/祖先/后代/兄弟/symlink、主根含 home 或位于 home、temp 含 home、存量危险条目、home 身份变化；外置 sharedStorageRoot/lease、storages symlink 指向外部、旧 domain 介质、owner/follower home 不同及介质身份变化；所有模式与三种 access，完整保护集合 deny 优先且无通配豁免 |
| Registry 未挂载 | 缺 compat/providers/storageDomain，或初始化抛错/断线/失败/拆除；fs/sandbox/permissionPresets 仍存活，未知 Full-access 不信任空 deny，恢复通知不循环 |
| 执行一致性 | fs write/edit/patch/delete/move 双端、shell/PTC/agent PTY 与各方言；工具 cap 不扩大；同步方法保持形状，未知能力拒绝；用户面板终端的既有边界保持 |
| 正常回归 | 健康空 Registry 的 byte parity、已知负边界、共享多 Host 排序/恢复、真实人工合法根变更、正常只读与读写九格矩阵 |

实施期命令与顺序沿用[开发工作流](../../development/plugin-development-workflow.md)：`pnpm compat:check`，再 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm kernel:probe`、`pnpm test`、`pnpm smoke:compose`、`pnpm smoke:behavior`、`pnpm smoke:journey`、`pnpm pack:check`、`pnpm smoke:packed`、`pnpm docs:check`。各 OS 原生运行 probe、三个 smoke 与 packed gates；不把 macOS 的静态检查当作 Linux/Windows 验收。审批适配必须在既有精确支持矩阵上验证；版本差异集中 `src/compat/` 做结构探测，不为实验修改正式 allowlist。Windows elevation 与非提升 git journey 的区分沿用仓库说明。

建议回归落点为现有 `registry.spec.ts`、`command.spec.ts`、`client-panel.spec.tsx`、`scope.spec.ts`、`registry-operation.spec.ts`、`shared-registry.spec.ts`、`process-fence.spec.ts` 及对应原生 e2e；实际归属以现有测试组织为准。新的攻击回归必须测防护行为，不能只断言“调用过 approval”。

## Risks 与实施前待定事项

1. **可信确认能力**：这是安全前置，不能假定标准 Web approval 已提供；公开 turn 外接缝和独立确认通道都需要 P0 证据。不满足则只能以禁止对应管理写操作作为缓解。
2. **可用性变化**：首版每次管理写都确认、无确认能力的 headless/旧宿主拒写、主根换名要求人工恢复、存量 home 根 withheld，均需清楚的错误与恢复路径，不能悄悄回退。
3. **兼容政策变化**：默认 unavailable 改变拒载/缺依赖时的 Full-access 行为；原始空根 parity 必须限定为“已证明健康空 Registry”。涉及旧 ADR 的变更须正式接受，不暗改历史决定。
4. **身份与迁移**：原始 key 跨重启的保存方式尚未决定；不允许迁移时按当前 realpath 给旧记录重新授权。新 metadata 不得成为第二份根表，也不能破坏旧编码降级 fail-closed。
5. **进程快照与读边界**：现有进程不自动撤权、同 uid secret 可读、普通文件 I/O TOCTOU 仍存在。验收说明必须保留这些限制，不能扩大本修复的保证。

## Documentation Impact

本文是本批修复的唯一方案入口；Plans README 双语只保留导航，接受与实施状态登记既有路线总账。本次不改 Accepted ADR、实现或 CHANGELOG，不宣称已修复或已发布。

实施时，同变更更新根管理 guide 与命令帮助、面板说明与错误词典，以及审批、Session origin、home 和 default authority 的相应 ADR 与架构，核对 README 双语的安全承诺；工程验证与发布状态只写既有路线总账。外部核查报告保留审计时点，不把修复后状态倒写成历史已无漏洞。

## Completion Criteria

- [x] 计划于 2026-11-05 经维护者明确接受，纳入物理介质保护、提交分界与 recheck/迁移边界三项审核补充；以下实现验收项仍未完成。
- [ ] BYP-01 两入口、直接 Registry 和共享 owner/follower 的管理写均受可信人工授权保护，且同 cookie 无法自行回答审批。
- [ ] redirected revive 不改 grant 目标；显式替换流程绑定用户确认的目标和策略。（P1 已完成前半：revive 只回原 grant，见 ADR-0027；显式替换的确认流程依赖 P2。）
- [ ] 主根换名/重定向不丢 deny，不发替换目标 grant；重启与无法确认身份的情况有经验证的保守行为。
- [ ] home 与物理介质完整保护集合的新登记、存量、主根/temp 重叠与执行层边界一致，未知能力明确拒绝。（P1 已完成新登记与存量部分；主根/temp 重叠与执行层 deny 属于 P3。）
- [ ] Registry 缺席时保守且基础 provider 服务存活；健康空表 parity 与幂等通知通过。
- [ ] 精确版本/原生平台/packed 制品门禁完成，结果与未覆盖项进入既有总账；用户文档与接受后的 ADR 同步。
- [ ] 满足以上条件后再按计划生命周期迁移 completed；发布仍需独立走既有发布流程。
