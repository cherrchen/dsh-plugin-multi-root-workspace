# 分支安全审查与硬链接隔离修复计划

## 状态与范围

Implementation complete：2026-10-16 完成审查并提出方案；Phase A（R2/R3 负授权修复）已按「修复设计（提议）」A 节实施，决策写入 [ADR-0017 §负授权保留与顺序无关冲突](../../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md#负授权保留与顺序无关冲突2026-10-16分支安全审查-phase-a)；Phase B（R1 Windows 祖先路径钉扎）已按 B 节实施并接入 runner，决策写入 [ADR-0020 §祖先路径钉住与 Job 排空](../../decisions/ADR-0020-windows-normal-deny-groups.md#祖先路径钉住与-job-排空2026-10-16phase-b-实机验证)；Phase C1（R4 全根硬链接预检）已按 C 节实施，决策写入 [ADR-0020 §全根硬链接预检与身份复核](../../decisions/ADR-0020-windows-normal-deny-groups.md#全根硬链接预检与身份复核2026-10-16phase-c1-实机验证)；Phase C2（`/workspace-folders isolate-profiles` 命令、profile 迁移与冒烟夹具）亦已实施，决策写入 [ADR-0020 §Profile 硬链接隔离命令](../../decisions/ADR-0020-windows-normal-deny-groups.md#profile-硬链接隔离命令2026-10-16phase-c2-落地)。2026-10-17 实施验收执行完毕：完整测试 771 通过 / 49 跳过、四项冒烟实跑通过、lint / typecheck / build / compat / docs / pack 门禁全绿，验收期修复与 POSIX 原生未验证等边界如实记入[路线账本「实施验收」节](./2026-09-12-multi-root-workspace.md#分支安全审查修复2026-10-16-起门禁已执行)。本文不表示新的安全合同已获采纳，也不改变既有发布状态；实施进度和发布状态仍以[路线账本](./2026-09-12-multi-root-workspace.md)为唯一来源。

审查对象：`feat/sandbox-permision-harden`，HEAD `3a34595`，相对本地 `main`（`3de8f21`）的 45 个提交、99 个变更文件。以最终代码为准，并检查相关未改动消费者。重点包含登记/分类/发布、三态权限、fs 与进程 fence、方言变换、Windows runner/broker/安装器、命令/面板响应、兼容性探针与测试门禁。本次未获取新的远端 CI 状态。

## 发现与证据

### R1 — P1：Windows 祖先改名可跨工具绕过只读边界

位置：`src/windows-deny.ts` 的 `walk` 与根的 parent guard；关联 `src/fs.ts` 的 `checkedTarget`。

当前 deny ACE 随文件系统对象移动，确实能继续拒绝同一个受限进程的写入；但 fs 工具运行在宿主令牌下，以登记路径检查权限，不受子进程的 deny-only SID 限制。仅保护根和直接父目录的 `FILE_DELETE_CHILD / WRITE_DAC / WRITE_OWNER`，不能阻止父目录自身改名。

Windows 原生复现（使用当前源码 runner、既有 broker，未重装服务；全部路径位于隔离夹具）：

1. 主根 `primary`，只读根 `parent/denied`，其中 `f` 内容为 `original`；另有独立 home 拒写根。
2. 受限 Full-access Node 子进程将 `parent` 改名为 `moved`。
3. 子进程尝试写 `moved/denied/f`，被 ACL 拒绝，输出 `SHELL DENIED EPERM`；改名本身成功，runner 退出 0。
4. 同一 scope 调用 `ctx.fs.resolve(moved/denied/f)` 与 `writeText(..., danger-full-access)`，写入成功，文件内容成为 `FS BYPASS`。

因此 ADR-0017 中“Windows 不需要祖先钉扎”的结论只覆盖同一 token 的内核操作，不能覆盖进程工具和宿主文件工具的组合。

### R2 — P1：read-only 会话 graft 固定读写根时遗漏 deny

位置：`src/sandbox.ts` 的 `widenForScope`（read-only 分支仅调用 `graftProfileArgs`）。

真实 registry 可构造以下状态，无需手改 JSON：登记 `parent/denied` 为只读 → 删除该目录 → 登记仍存在的 `parent` 为固定读写。追加校验只检查 available 根，因此父目录被接纳；scope 同时发布 writable `parent` 和 denied `parent/denied`。

以此状态生成 read-only profile，Seatbelt 只有父目录 allow，bwrap 只有父目录 bind，Landlock 只有父目录 rw，三者均遗漏拒写边界。Windows profile 已拒绝该重叠；fs 工具同样正确返回 `FS_SANDBOX_DENIED`。POSIX 子进程与 fs 因此不一致。

证据级别：在 Windows 上实跑真实 registry 和四个后端的 profile 构造，确认参数缺失；未在本次审查中原生执行 macOS/Linux 内核。不能把 profile 验证描述成 POSIX 实机拒写/绕过证据。

### R3 — P1：排序能把有效负授权变为 invalid 并抹去

位置：`src/registry.ts` 的 `add`/`move`/`publish`，`src/roots.ts` 的 `classifyStoredRoot`。

在 R2 的 missing 子根 + available 父根状态下，调用真实 `registry.move` 将父根移到子根前面。分类器先接受父根，再把子根标记为 overlap-invalid；`publish` 对所有 invalid 记录均不发布，导致 `deniedRoots` 从子根路径变成 `[]`。重新建立子目录后，Full-access 的真实 `ctx.fs.writeText` 成功写入 `REORDER BYPASS`。

这不是 ADR 已接受的“无法解析的损坏记录不贡献 deny”：记录字段完整、访问级别明确，只是用户调整列表顺序。展示顺序不能撤销明确的只读边界。

### R4 — P1：Windows 拒写 ACL 会影响硬链接的其他名字

位置：`src/windows-deny.ts` 的 `protect`/`walk`。现有[实机笔记](../../../.agent/note/windows-deny-broker-packaged-child.md)已记录 pnpm store 与 profile/其他项目共享文件的情况，本次没有重复安装 pnpm 实验。

对硬链接文件的安全描述符修改作用于同一文件对象，不能限制为“只改 profile 中这个路径”。影响不仅是 root deny SID：现有 writer 也合并 OWNER RIGHTS 与 owner 的 ACE。不能笼统保证其他进程的授权完全不变。

外部方案提出在 `walk` 到达普通文件时检查 `nlink > 1`，但当前遍历先给目录写 `OICI` 可继承 ACE，再进入子节点。[SetSecurityInfo](https://learn.microsoft.com/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo) 可自动传播 ACE 到已有子对象，所以检查必须先于所有根的目录 ACL 修改，不能等到文件本身才拒绝。该传播风险来自代码与 API 合同，本次未对外部方案尚未实现的检查做原生回归。

## 修复设计（提议）

### A. 先统一负授权规则（R2、R3）

（**已实施**：2026-10-16 落地；决策与回归清单见 ADR-0017 本轮修订，证据数字见路线账本「分支安全审查修复」节。）

1. 在 read-only 的 POSIX 分支中，对 graft 后的 profile 同样调用 `denyProfileArgs`：Seatbelt 追加 deny，bwrap 强制 ro-bind（缺失源拒绝启动），Landlock 重叠时明确拒绝。保留同步/异步返回形状。
2. 新增根与 revive 的冲突校验纳入仍有完整、可信 grant 字段的 missing/redirected 登记的 recorded boundary；仅排除本次明确 revive 的同一记录。不得把“当前不可用”解释为“没有权限约束”。
3. 既有重叠存量必须有安全处理，不能只修 add。区分字段不可解析与成员冲突：有可信只读字段的冲突记录仍保留负授权，或将该 primary 标记为不可安全执行并拒绝相关写入，直到用户移除/修复冲突。优先采用保持可信负授权的设计，细化状态与提示；不得猜测多 grant 字段歧义记录的权限。
4. 分类和投影的安全结果不能依赖展示顺序；`move`、alias、refresh 和重启均不得撤销 deny。继续经 `multiRootScope` 唯一根发布入口，不新建平行授权表。
5. 回归矩阵：missing/redirected、两种包含方向、三种 session mode、不同登记顺序、排序/刷新/重启，以及 fs/各内核后端。对不可表达的状态断言拒绝启动，而非命令没执行就误判写入被拒。

### B. Windows 祖先路径稳定性（R1）

（**已实施**：2026-10-16 落地 runner 集成；机制决策与生命周期见 ADR-0020 本轮修订，证据数字见路线账本「分支安全审查修复」节。实现要点：`src/compat/windows-path-guard.ts` 经公开绑定接缝钉住全部祖先；`src/windows-deny.ts` 在 token/ACL 前获取钉住、直接子进程退出后经 `terminateWindowsJobAndWait` 排空 Job 再释放；实机探测否决了属性级句柄方案，改用 GENERIC_READ。）

建议先原型验证生命周期内的目录句柄钉扎：在启动前打开拒写根及全部必要祖先目录，保留共享读写但不允许 delete sharing，直到受限子进程及其受管理后代退出。目的是阻止受限执行期间搬走登记路径，同时避免持久化修改 `C:\\`、用户目录等整条祖先链的 ACL。

这是待原生验证的方案，不是已证明可行的最终实现。验证包括父目录/祖父目录 rename、已开句柄冲突、另一个卷、路径别名、junction、ConPTY、取消和 Job 后代生命周期；无法建立保护时必须在 spawn 前失败关闭。读取属性/文件身份通过同一个句柄完成，所有失败路径关闭句柄。原生调用与公开 helper 兼容差异放在 `src/compat/`。

必须新增跨工具回归：真实受限 shell 尝试搬走祖先，然后宿主 fs write/edit；不能仅测试“搬走后同一子进程仍写不了”。不采用扫描磁盘追踪搬走的根，也不只给直接父目录加一条 DELETE deny 后就声称覆盖全部祖先。

### C. 硬链接失败关闭与 profile 隔离（R4）

（**C1 已实施**：2026-10-16 落地 runner 侧全部要点——全根只读预检、nlink>1 保守拒绝、快照遍历 + 活句柄 `verifyHandle` 复核、继承写前名单比对、诊断区分 home 与登记根、非事务限制如实写入 ADR；决策见 [ADR-0020 §全根硬链接预检与身份复核](../../decisions/ADR-0020-windows-normal-deny-groups.md#全根硬链接预检与身份复核2026-10-16phase-c1-实机验证)，证据数字见路线账本。**C2 已实施**：`/workspace-folders isolate-profiles` 落地为宿主侧维护命令——默认只读检查、`--apply` 原子迁移配置、`dsh.profile` 确认的 profile 判定、无 yaml 依赖的严格子集扫描器、整 home 多链接扫描与 incomplete 结论、PowerShell 安全引用的人工重装步骤；冒烟正向（`ensureProfileCopyImport` 在首个 `dsh plugin add` 前写 copy）与负向（默认硬链接 scratch profile 断言真实预检拒绝）均接入 `smoke-behavior`。决策见 [ADR-0020 §Profile 硬链接隔离命令](../../decisions/ADR-0020-windows-normal-deny-groups.md#profile-硬链接隔离命令2026-10-16phase-c2-落地)，证据数字见路线账本。CI 非提权 lane 按 C 节要求评估后 defer（GitHub Windows runner 全程提权，另起非提权进程需第二账户），记录在路线账本「分支安全审查修复」节。）

#### runner

- 在任何文件系统 ACL 修改前，对**全部** deny roots 做只读预检。拒绝普通文件 `nlink > 1`，并拒绝无法完成检查的树；遵守现有重解析点边界，不跟随 junction 扫到根外。
- 所有根预检成功后才进入 ACL 写入。原生句柄上的 link count / file identity 复核用于缩小路径替换窗口，但单个文件复核不能消除父目录 ACL 自动传播的窗口。
- 诊断包含根、文件、link count，区分 home 与用户登记根；所有根同样拒绝，不保留用户根的共享 ACE 特例。`nlink > 1` 不证明存在根外名字，本策略是保守拒绝，不宣称已定位外部链接。
- 预检到写入之间仍可能有并发链接/替换；在 ADR 明确准确的威胁模型。不得承诺事务性零副作用，也不得把所有路径替换竞态都概括为“只会外溢”。若要求在恶意并发修改下也绝不外溢，需另行验证更强的句柄/隔离方案。
- 清理失败保留原错误与诊断，不吞掉启动失败，不启动裸进程。

#### 用户命令（建议名）

建议沿用 `/workspace-folders isolate-profiles`；默认只读检查，显式 `--apply` 写配置。范围明确为宿主解析的 `$DSH_HOME/profiles/*`，不是会话 cwd。命令必须是用户显式触发的宿主维护操作。

- 检查 YAML 的真实顶层键：已经是 `copy` 则不变；未配置则添加；已有其他值时检查模式报告差异，显式 apply 才替换为 `copy`。拒绝歧义/损坏 YAML，保留其余内容，原子写入；不跟随 profile/config 的重解析路径修改 home 外文件。
- 缺配置时检查模式报告；apply 可为确认是 profile 的目录创建最小配置，不能把任意 home 子目录都当成 profile。具体识别沿用已支持 DSH 的实际布局。
- 不删除 `node_modules`，不自动调 pnpm。输出正确引用/转义路径与 profile 名的 PowerShell 步骤；提示退出所有使用相关 profile 的宿主后，在对应 DSH_HOME 下按 lockfile 重装。
- 报告“配置已设置，存量依赖仍待重装”，不能把配置写入当作已隔离。检查模式统计扫描路径数/多链接文件数和无法检查项；不完整扫描不报干净。
- 检查整个 home 是必要的：profile 之外也可能有硬链接；新增 profile 仍需采用 copy 或重新检查。copy 导入不会自动修正 Administrators 属主。

#### 历史 ACL 与用户根

- 删除 profile 的旧链接、改成 copy 重装不能自动清除 store/其他项目的既有 ACE。迁移指引必须明确区分预防未来外溢与历史修复。
- 不对整个 pnpm store 执行 `icacls /reset`，也不无差别删 OWNER RIGHTS ACE；没有原始 ACL 快照时无法可靠恢复原状。先提供只读诊断，历史清理作为单独、可审阅的维护操作。
- 用户登记根同样 fail-closed；对 pnpm 依赖给 copy 重装步骤，对普通硬链接说明需建立独立文件副本并保留内容/权限。不要建议跳过 `node_modules` 或只跳过硬链接文件，它们仍是拒写根内容。

#### 冒烟与原生测试

- scratch profile 在首次安装前明确使用 copy；保留默认硬链接 profile 的负向回归，不能只测试修好后的环境。
- 原生测试：深层硬链接、多根中最后一个根含硬链接、同树内部多链接、protected DACL、无权限扫描、普通文件、重解析点、预检失败后所有根及外部链接的 ACL 快照未变化。
- 独立副本正向用例必须证明 ambient 写仍可用、拒写根不可写；内容与外部 ACL 前后比较，且实际启动子进程。
- CI 增加非提权运行证据；broker 安装和需提权原生用例分开。不得把缺 broker、MSIX、属主失败或硬链接失败转换成安全断言通过。

## 验证记录与实施验收

本次审查运行了 host/client TypeScript 检查，均通过；运行 `vitest run --exclude 'tests/**/*.e2e.ts'`，44 个文件通过，638 项通过、45 项跳过。额外隔离复现确认 R1 的 Windows 原生跨工具绕过、R3 的真实登记/排序/fs 写入和 R2 的 profile 缺失。未执行完整 e2e、跨平台内核矩阵、三个安装冒烟或 packed smoke；未重装 broker。

实施顺序建议：A 的否定权限修复 → B 的 Windows 路径稳定性原型及修复 → C 的 runner 硬链接预检 → profile 命令/迁移/冒烟夹具 → 完整门禁。各项先以复现回归锁定失败，再修实现；不要让后三项的上线掩盖前两项权限绕过。

实施验收须运行 `compat:check`、lint、typecheck、build、test、`kernel:probe`、三项 smoke、`pack:check`、`smoke:packed`、`docs:check`，并在启用平台与全部支持版本执行相应矩阵。Windows 非提权与提权证据分别记录，跳过必须有具体原因，不以 CI 绿色代替新回归的实际执行。

## 文档影响

实施时修订 ADR-0017（负授权、排序无关性与 Windows 祖先保护）、ADR-0020（硬链接与 ACL 副作用）、指南中英文、命令参考与既有实机笔记；进度与执行证据回到路线账本。CHANGELOG 中英文只按仓库发布流程记录实际完成的变更，不把本 Proposed 计划写成已发布功能。
