# Worktree 感知的附加根建议与 Git 元数据授权实施计划

> 状态：**P5 完成；P6 未开始**。先完成 B（P1–P7），再实施 A（P8–P10）。实施与验证状态见[路线账本](./2026-09-12-multi-root-workspace.md#进度总账)。
> 决策：[ADR-0039](../../decisions/ADR-0039-worktree-aware-root-suggestions.md)（Accepted，2026-11-09 第十八次修订）。
> 需求：[§7.16–§7.18](../../requirements/multi-root-workspace.md#7-行为约束)。

## Goal

在插件内按以下顺序交付 worktree 支持：

1. **B：worktree 发现与附加根建议。** primary root 是 main 或 linked checkout 时，发现同一 common 下外部/预存在/其他创建者的 worktree，提示用户把该 worktree 加为 `inherit` 附加根；**默认 pool 没有特殊排除**：主仓库作为 primary 时 `.agents/worktrees/<id>` 位于 primary 内，按包含规则过滤；primary 本身是 pool worktree 时，兄弟 pool worktree 仍是合法 B 候选（再受 registry/上限/ignore 约束）；永不自动添加。
2. **B 的删除生命周期。** 已登记的 B 根只有在 `record.path` 确认缺失时才提供专用清理入口；面板显示、用户显式触发、owner 复验、永不自动删除；缺失根占额度直到清理或手动删除。
3. **A：linked worktree 的共享 Git 元数据授权。** 用户确认后登记 canonical common git dir 为 `inherit` 根，解决默认 pool 和外部 linked checkout 的 `git add` / `git commit` 写入缺口。

插件详情提供与「启用附属根 Skills」同款的全局开关，默认开启 A/B 建议及 B 专用清理。

## Background

Worktree 可能被 Git 或手动删除、移动。B 解决兄弟 checkout 的源码树访问和已登记根清理。A 解决 linked checkout 作为 session primary 时的 Git 元数据写入：私有 `index` 在 admin 下，`objects`、`refs` 等位于共享 common，二者通常都在 primary 外。默认 pool 下主 checkout 包含 primary，按既有重叠规则不能登记整个主 checkout。

ADR-0039 已经过多轮只读复审，覆盖：

- 不运行任何 Git 子进程，只消费插件自己打开并解析的元数据快照；
- 两种 checkout 形态（`.git` 目录、`.git` 文件 + `commondir`）都遍历完整祖先链；
- submodule、linked worktree submodule、bare、separate main、worktreeConfig、relativeWorktrees、split/sparse index 的 inactive 边界；
- HEAD 语法、checkout/admin 文件系统身份、primary/candidate owner 复验；
- `unactivated`/`active`/`lost` 三态与 `WorktreePromptWaitResult` 判别联合；
- 映射 prune 只依据 owner 成功完整快照。

## Current State

- ADR-0039 第十七次修订接受 B；第十八次修订确定 A 的授权边界与全局开关。P1 实现尚未开始。
- 本计划、需求 §7.16–§7.18、路线账本条目属于 P0 文档。
- 现有 Registry、scope、面板、`/workspace-folders` 命令与 Connection RPC 已经存在；本功能新增独立的 `multi-root-worktrees` 行与 `WORKTREE_ENDPOINTS`，不修改上游包。
- 当前没有 worktree 发现、提示、全局开关、`worktreeRoots` sidecar、专用 cleanup 或 Git 元数据授权的实现。

## Scope

### In scope（先 B，后 A）

- primary 必须是 Git main 或 linked checkout 根；普通目录/仓库子目录不执行本功能动作，曾 active 后失效也停止后台活动，仅收尾旧提示/资源。
- 受控枚举 `<common>/worktrees/*/gitdir`；包含 workspace 创建前已存在、由终端/IDE/forge/其他 DSH 创建的 worktree。
- 候选必须属于同一 common、双向指针一致、admin 在 `common/worktrees/<id>` 下、HEAD/common 结构合法。
- 用户确认后添加 `access='inherit'` 的附加根；提示按 workspace 共享，按 session mode 过滤。
- 已登记 B 根的 `missing`/`moved`/`changed`/`unregistered` 生命周期；专用 cleanup 入口；sidecar `worktreeRoots`。
- `worktreePromptWait` 判别联合、`unactivated`/`active`/`lost` 三态、watcher 释放与恢复。
- 完整祖先链、两种 checkout 形态、Unicode 路径等价、HEAD 语法、checkout/admin 身份、owner 复验。
- 平台：macOS / Linux / Windows（Windows 的文件句柄/文件 ID 实现按平台能力；无法提供稳定身份时不发提示或 stale）。
- A 仅在 linked primary 的 `workspace-write` 会话提示；通过完整快照绑定 primary/admin/common，显式确认后经 owner 新建普通 `inherit` 登记。
- `multi-root-worktrees.enabled` 全局开关默认 `true`，位于插件详情卡，与附属根 Skills 的开关独立生效。

### Out of scope

- 授权整个主 checkout、通过 effective cwd 选择授权目标、修改现有附加根权限来绕过 A 门禁。
- 自动添加、自动删除、自动清理；后台静默扩大授权。
- `git worktree list` 或任何 Git 子进程。
- 解析 commit 对象、读取 `objects`、执行 hooks/fsmonitor/attributes。
- submodule（含 linked worktree 本身是 submodule）、bare 派生 worktree、`--separate-git-dir` 主 checkout、`extensions.worktreeConfig=true`、`core.repositoryformatversion=1`/`--relative-paths`、split/sparse index。
- 未登记/未授权的外部 gitdir、UNC/设备路径、越界 symlink。
- **`forget-workspace` 新命令/RPC/owner 删除路径延期**：v1 不交付；ADR 只记录为未来 Registry maintenance，单独计划/需求排期。v1 删除只走 `removeForDeletedWorktree`，不依赖 forget。
- 修改 `primary-overlap`、`maxAdditionalRoots` 计数规则、上游包或 DSH 版本分支。

## Design

实现以 ADR-0039 为准，计划只固定模块边界：

| 模块 | 责任 | 关键约束 |
|---|---|---|
| `worktrees/metadata` | 可信 fd 逐段打开、`O_NOFOLLOW`/`O_NONBLOCK`、`fstat`、有界读取；config/index/HEAD/仓库结构解析 | 不启动 Git；不跟随中间/最终 symlink；FIFO/设备拒绝；解析失败即 inactive |
| `worktrees/activation` | 本层 `.git` 门禁、两种 checkout 形态、完整祖先链、Unicode 路径等价、submodule/inactive 判定 | 普通子目录第一道门禁直接退出；阴性继续更外层；无法排除即 inactive |
| `worktrees/inventory` | `<common>/worktrees/*/gitdir` 枚举、候选 key、`CommonState`/`WorkspaceState`、watcher | 不运行 `git worktree list`；admin/父目录 watcher 上限；`filename null` reconcile |
| `worktrees/prompt` | `WorktreePromptWaitResult`、`unactivated`/`active`/`lost`、显式重新检测、候选重新评估 | unactivated/lost 都停止后台重查；所有响应禁止 retry 字段；旧 prompt ID 失效 |
| `worktrees/registry` | `addNew`/`removeForDeletedWorktree`、sidecar `worktreeRoots`、映射 prune | owner 串行队列；完整快照才 prune；不 revive 手动记录 |
| `worktrees/owner` | primary/candidate 完整判据、HEAD 语法、checkout/admin 身份、祖先索引 | 写入使用同一 canonical 值；任何变化 `prompt-stale` |
| `worktrees/client` | 对话框、面板行、RPC schema、`stale`/`lost` 客户端行为 | 不发送路径；宿主/客户端同时校验判别联合 |
| Settings 与插件详情卡 | Host 开关、现代/旧版适配、卡片 Switch 与运行时失效 | 复用附属根 Skills 接缝与卡片，独立配置；Host 门禁先于后台活动和写入 |

## Implementation

### P0 文档（本阶段完成）

- [x] ADR-0039 第十八次修订（Accepted）。
- [x] 需求 §7.16–§7.18。
- [x] 本计划。
- [x] 路线账本条目（P0 / P1 未开始）。
- ADR 已满足 P1 的设计前置条件。

### P1 元数据快照与解析器（完成）

- 可信目录句柄逐段打开；中间目录/最终文件拒绝 symlink；`O_NOFOLLOW`/`O_NONBLOCK`；同 fd `fstat`；有界读取。
- config 快照：include/core.worktree/worktreeConfig/relativeWorktrees/split/sparse/objectFormat/repositoryformatversion/core.bare；记录 precomposeUnicode/ignorecase。
- HEAD 语法：`ref: refs/<refname>` 或 40/64 hex；primary/common/admin 共用。
- repository 结构：HEAD/config/objects/refs；admin 的 `HEAD`/`gitdir`/`commondir`；common。
- index 解析：v2/v3/v4、`link`/`sdir`/`040000`/未知版本拒绝；路径等价。
- 祖先链：两种形态、逐层 config/index、完整相对路径、阴性继续、无法排除 inactive。
- 单测覆盖最终 index 换链、中间目录换链、FIFO、split/sparse 伪 index、NFC/NFD、祖先遮蔽、sha256/version 1。

### P2 发现、激活、watcher 与 Host 设置（完成）

- 在 `multi-root-worktrees` 行新增默认 `true` 的 `enabled`，复用附属根 Skills 的现代 volatile Config / 旧版 Settings namespace 适配；无 Settings UI 时读取 loader Config。Host 按 ADR §9 控制发现和专用清理，关闭时唤醒 waiter、清理资源并失效旧提示。P4 接通 owner 写入前门禁。
- inventory、候选 key、`CommonState`/`WorkspaceState`、workspace 共享。
- `activation` 三态；首次门禁拒绝不建 watcher/sidecar。
- primary/ancestor watcher best-effort；active 时长轮询重挂复验；`lost` 清候选并释放 watcher/waiter/定时器，停止重挂。
- 恢复只经用户面板/命令 `list` 或显式重新检测；禁止自动 wait、one-shot 与周期重查；重建时清 `evaluated`、保留明确 `prompted`。
- 验收：普通目录/仓库子目录无后台；active→lost 停止后台→显式恢复新 ID；候选去重/上限/degraded。

### P3 Prompt RPC、UI 与插件设置开关（完成）

- 在「设置 → 插件 → Multi-root Workspace → 插件详情」现有卡片内，于「启用附属根 Skills」旁添加独立 Switch「启用 Worktree 附加根建议」/「Enable worktree root suggestions」。复用同一 Settings form 订阅与写入、revision、错误提示与旧版 `settings.plugin.item` 适配；支持即时生效和持久化，不另注册包级卡片。
- 关闭时退出提示和专用清理 UI，处理 `worktree/not-enabled` 并停止轮询；开启后对当前 live session 重新检测，已 `lost` 的 workspace 仍走显式恢复。
- `WorktreePromptWaitResult`：`prompt`/`timeout`/`unactivated`/`lost`/`stale`；所有分支禁止 `retryAfterMs`。
- 宿主 `WorktreeResponseMap` 与客户端 schema 同时校验；拒绝缺字段/错误 status/多余 retry。
- 面板/对话框：只展示 eligible 候选、`effectiveAccess`、remaining；**P3 只做只读预览，生产 `worktreePromptResolve`/确认按钮保持禁用（`worktree/not-enabled` 或路由未挂载），不得调用 Registry 写入**。
- resolve 后旧 prompt 失效；`stale`/`lost` 的客户端行为按 ADR-0039 §4.3。

### P4 Registry、owner 写路径与 sidecar/cleanup（完成）

> P4 是**首次可写阶段**：`addNew` 与完整 owner 复验必须在同一阶段实现；P3 的确认操作在 P4 验收通过前不启用。

- `addNew(primaryRoot, { path, access, expected })`：owner 串行队列；分开 primary/candidate；复用 add 校验；只新建不 revive。确认与专用写入同时接入 ADR §9 的设置门禁，覆盖在途 owner 请求的提交边界。
- owner 复验：primary 完整判据（含完整祖先链）+ candidate 激活判据（含祖先 gitlink）；primary/common/admin HEAD 语法；candidate admin HEAD == expected；`rootIdentity`/`adminIdentity` 比对；任何变化 → `prompt-stale`。
- `addNew` 在 owner 同一队列操作内先持久化登记再写 B 映射，返回 `{ id, path, addedAt, registryEpoch, registryRevision }`；禁止 follower 事后补写。保持跨文件崩溃窗口按手动根处理的降级。
- `removeForDeletedWorktree`：`record.path` 确认缺失 + `rootId + path + addedAt`；路径存在/无法判定/inaccessible → not-eligible。
- sidecar 全部写入（ignore/reset/映射新增、删除、prune）复用既有 Registry owner/lease/串行队列；follower 只走认证 IPC，不写文件。固定 sidecar 路径绑定 store，握手校验配置；teardown drain 写入后才释放 lease；内部 helper 不嵌套排队。
- prune 在 owner 队列内重取当前 sidecar 与完整 `RegistrySnapshotView`，不接受客户端旧快照作写入依据。跨 epoch 按 `rootId + path + rootAddedAt` 核对，匹配则重绑当前 epoch/revision，不匹配仅删映射；不可用或完整快照失败保留映射。精确规则以 ADR §5 / §6.8 为准。
- IPC 增加严格 schema 的 sidecar 查询/ignore/reset/reconcile 操作；映射新增/删除封装在 Registry 操作内，旧 epoch 请求拒绝、不明结果先对账，不自动重放。owner memory-only 降级不得变成 follower 各写副本。
- inactive 时专用 cleanup/ignore/reset/reconcile 不写入，停用 Registry change 触发的本功能任务；新 owner 仅在 workspace 显式重新激活后核对映射。
- 清理后释放额度；不自动删除；`forget-workspace` 延期，不在本阶段实现。
- 验收：等待 owner 时替换候选 → 无写入；authority 不可用 → 映射保留；owner 确认空 → prune；两个 Host 同时提交新增/删除/prune，通过 barrier 强制交错，验证串行执行且无覆盖/复活；旧空快照后新增的映射保留；owner 重启/接管后匹配旧映射重绑、不匹配修剪，旧 epoch 在飞请求拒绝。

### P5 Owner 竞态与平台验收（完成）

> P5 不新增可写入口；写路径已在 P4 与 owner 复验同阶段落地。P5 只验证竞态、身份和平台行为。

- 同路径删除重建（同提交/同 adminId/同 HEAD，inode 变化）→ `prompt-stale`。
- primary/candidate 任一激活判据在等待期间变化（祖先新增 `160000`、primary `.git` 移走）→ `prompt-stale`。
- 平台：macOS 文件句柄/Unicode；Windows 文件 ID/reparse point；无法提供稳定身份时不发提示/直接 stale。
- 验收等待 owner 时替换候选，断言 Registry 无写入；P3 确认在 P4 前不可用。

### P6 验证与平台矩阵（未开始）

- 单测：metadata/activation/inventory/prompt/registry/sidecar/owner。
- 集成（**Web**）：`connection` + `webServer` 存在的真实宿主 + 客户端 schema；确认、清理、`WorktreePromptWaitResult` 全链路。
- 集成（**headless**）：组合可启动、现有 `/workspace-folders` 命令与 Registry 行为正常；不要求面板 RPC 路由，不为验收新增浏览器入口。
- e2e：
  - 外部 worktree 提示 → 确认 → `inherit` 根 + 清理；
  - **默认 pool 两场景**：主仓库为 primary 时 `.agents/worktrees/a`/`b` 位于 primary 内 → 无提示；以 `a` 为 primary 时 `b` 同 common、互不包含 → 进入 B 候选；
  - **P3 确认门禁**：P4 验收前 `worktreePromptResolve` 不可用，断言 Registry 无写入；
  - **owner 竞态**：等待 owner 时替换候选 → `prompt-stale`，Registry 无写入；
  - submodule / linked submodule / bare / separate main / version 1 inactive；
  - **snapshot/owner**：两种空快照、并发新增/删除/prune、owner 重启与接管、跨 epoch 重绑/修剪、旧请求拒绝，覆盖 ADR §5 / §6.8；
  - ordinary dir/repo subdir 无后台；
  - active→lost 停止后台→显式恢复新 ID；
  - 同路径删除重建 → stale；
  - `forget-workspace` 新入口不存在（延期），专用 cleanup 不依赖它。
- Settings：覆盖默认开、关闭/开启即时生效、跨重启持久化、现代/旧版卡片不重复、已登记根保留、旧提示和未提交的异步任务失效。真实 Web 验证与 Skills 并列且相互独立；headless 验证 loader 显式关闭。
- 平台：macOS 文件句柄/Unicode；Linux；Windows 文件 ID/reparse point；无法验证的行显式 skip 并打印原因。
- 门禁：`pnpm lint`、`typecheck`、`test`、`build`、`docs:check`；需要时 `compat:check`。

### P7 B 文档与发布准备（未开始）

- 更新 B 的 requirements、双语 README、路线账本和实现文档；CHANGELOG 仅在实际发布时更新。完成 B 的验收和发布准备后进入 P8，是否拆成两次发布由路线账本记录。
- 不修改上游；不新增 DSH 版本分支。

### P8 A：common 候选与来源契约（未开始）

- 复用 P1/P2 的 linked primary 快照，按 ADR §1 识别 `git-common` 候选。绑定 canonical primary、admin、common 的稳定文件身份和 admin HEAD；应用 `probeAdd`、全局设置与 `workspace-write` 门禁。B 的 inventory 继续独立。
- 验收：默认 pool 和外部 linked checkout 都能得到相同形态的 common 候选；普通主 checkout、仓库子目录、仅 effective cwd 切入 linked checkout、伪指针、不受支持布局、既有登记或根校验拒绝时不产生 A 提示。分离式 gitdir 反例验证候选永远不会变成 common 的父目录。
- P8 只构造宿主候选；生产界面与确认在 P9 同阶段接通。

### P9 A：提示、确认与 owner 提交（未开始）

- 扩展 B 的提示联合、双端 schema、工作区去重/忽略与可见队列。对话框分别展示 A/B 文案，A 显示 canonical common、`inherit`、共享元数据范围及持久性。客户端沿用 `sessionId + promptId + action` 确认，无路径参数。
- 同阶段接通 `addNew` 的 A 分支。请求 Host 和 owner 分别重跑来源与身份检查，owner 队列内按普通 Registry 规则新建；不 revive、不写 B 清理映射。开关关闭或 mode 变化时作废旧提示；已确认的普通根通过普通 Remove 撤回。
- 验收：验证送交 owner 前的 mode 切换和设置关闭都会作废旧提示。用队列屏障在 owner 提交前替换 common/admin、修改反向指针或祖先索引，断言无写入。按 ADR §9 验证跨 Host 已送交 owner 请求的边界。A/B 同时可见时，一个 session 的 A 过滤不得堵住该 session 的 B 提示。

### P10 A：受限 Git 旅程、回归与发布准备（未开始）

- 在隔离夹具中分别用默认 pool 和外部 linked checkout 作为 live session primary。确认前，真实受限 shell 的 Git 写入因缺少元数据权限失败；确认后，在同一 `workspace-write` 模式、不走 `danger-full-access` 的条件下完成 `git add` 和 `git commit`，核对 index、commit/ref 产物。验证主 checkout 源码（当前 primary 之外）和无关目录仍拒写；普通 Remove 后，新进程再次无法写该 common。
- 覆盖 `read-only`、`danger-full-access` 无 A 提示、per-tool cap、authority 不可用以及设置关闭/开启；删除 linked checkout 后，A 根保持普通 Registry 生命周期，专用清理只追踪 B 根。
- 按现有 macOS / Linux / Windows 内核探测记录实跑与 skip 证据，回归 B 和完整门禁。更新实现文档、双语 README 与路线账本，实际发布时同步双语 CHANGELOG。

## Dependencies

- ADR-0039 已 Accepted；P8 以 B 的 P1–P7 完成为前置条件。
- 现有 Registry、Connection RPC、panel controller、Registry owner 串行队列、scope/authority 语义。
- 平台能力：POSIX `openat`/`O_NOFOLLOW`/`O_NONBLOCK`；Windows 文件 ID/reparse point；Node 版本按现有支持矩阵。
- 无新增可选 peer；无上游改动。

## Validation

- 所有新行为先有失败用例，再有实现；回归覆盖 ADR-0039 §2.5 的每个布局。
- “无 Git 子进程”用进程 spy / 环境断言；`core.fsmonitor` 脚本不得执行。
- “外部文件没有被读取/脚本没有执行”用外部 marker/监控断言，不只无提示。
- RPC 判别联合由宿主和客户端 schema 双重校验；错误 shape 必须拒绝。
- 映射 prune 的 authority 空快照用例必须端到端覆盖。
- 文档门禁：`pnpm docs:check`。

## Risks

- **保守 inactive 的可用性代价**：submodule/祖先链/Unicode/未知格式一律 inactive；宁可漏提示，不可错误授权。面板应能解释 inactive 原因，但不泄露路径外内容。
- **解析器复杂度**：v2/v3/v4 index、config、HEAD、祖先链、Unicode 等价；解析失败必须 fail closed。
- **Windows 文件身份**：无稳定 file ID 时不能回退到路径比较；不发提示或 stale。
- **停止与恢复**：unactivated/lost 都停止后台；显式恢复才重新检测。测试推进时钟断言零重查、零 sidecar 写入；所有 RPC 分支拒绝 retry 字段。
- **Registry 空快照**：`available=false` 的空列表不是“没有根”；prune 只消费同一次 owner `RegistrySnapshotView`，`available=true` 的空快照才删除映射。
- **写入口时序**：P3 的确认在生产 RPC 中默认禁用；P4 将 `addNew` 与完整 owner 复验同阶段接通，P5 只做竞态/平台验收。
- **默认 pool**：没有特殊排除；主仓库 primary 由包含规则过滤，pool worktree primary 的兄弟仍可成为 B 候选。
- **不自动删除**：missing 根占额度是刻意取舍；面板必须显眼。

## Documentation Impact

- ADR-0039（状态与修订）。
- 需求 §7.16–§7.18（含 `forget-workspace` 延期）。
- 本计划与 `docs/plans/README.md` active 列表。
- 路线账本（唯一进度/发布状态来源）。
- 发布时 `CHANGELOG.md` / `CHANGELOG.en.md`。
- 如实现引入新的 RPC/客户端契约，更新面板/协议文档与 ADR-0005 的关联说明。

## Completion Criteria

- P1–P7 的 B 行为验收后完成 P8–P10；默认 pool 的兄弟 checkout 与 A 的 common 分别验收。
- A 经显式确认后，默认 pool 和外部 linked checkout 的受限 `git add` / `git commit` 均通过；主 checkout 源码和无关路径仍拒写。
- 插件详情开关与 Skills 同卡、默认开启、实时生效并可持久化；关闭后客户端停止 worktree 请求，当前 Host 停止后台任务。已登记根仍可在普通根管理中操作。
- P3 确认门禁生效；P4 才接通写路径，等待 owner 替换候选时 Registry 无写入。
- 所有 inactive 布局在入队和 owner 提交都拒绝；owner 不接受过期提示。
- 无 Git 子进程、无外部 index/object/config 读取；Web 宿主/客户端 RPC schema 一致，headless 只验证组合启动与现有命令/Registry 正常（不新增浏览器入口）。
- 删除只在面板显式触发；缺失根占额度；不入自动清理；`forget-workspace` 明确延期。
- sidecar 所有写入由唯一 owner 排序；prune 取队列内当前完整快照；两种空语义、并发交错、重启/接管跨 epoch 核对通过。
- 平台矩阵与文档门禁通过；发布状态只记录在路线账本与 CHANGELOG。
