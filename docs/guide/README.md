# 用户指南

English: [README.en.md](./README.en.md)

面向使用者的指南：README 只写"怎么做"，这里补上"为什么"与"具体语义"，遇到非默认情形时查阅。

## 目录

- [支持矩阵为什么是精确版本清单](#支持矩阵为什么是精确版本清单)
- [allowBuilds 那一步在授权什么](#allowbuilds-那一步在授权什么)
- [各安装来源的差异](#各安装来源的差异)
- [`/workspace-folders` 命令的完整语义](#workspace-folders-命令的完整语义)
- [访问级别、数量上限与 per-tool 封顶](#访问级别数量上限与-per-tool-封顶)
- [Worktree 附加根建议的完整语义](#worktree-附加根建议的完整语义)
- [组合里实际发生了什么](#组合里实际发生了什么)
- [模型侧与面板侧的行为](#模型侧与面板侧的行为)

## 支持矩阵为什么是精确版本清单

本插件替换的是 `ctx.fs` 与 `ctx.sandbox`——安全边界本身——而它识别内核沙箱方言靠的是对具体上游版本实测出来的 argv 形状。所以 `peerDependencies` 只列真正跑过全套验证的版本，启动时也会再查一遍：宿主的版本不在清单上，或者若干个 `@deepseek-ai/dsh-*` 混装了不同版本，那么 fs / sandbox / registry / instructions / lsp / workspace-files 六行**不启动**，组合退化成"没装这个插件"，并打印一条说明。诊断办法见[故障排查](../troubleshooting/unsupported-dsh-release.md)，理由见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。

## allowBuilds 那一步在授权什么

本插件带一个需要构建的原生依赖 `koffi`（Windows 上 Registry Authority 用的 FFI 封装；其他平台装了不用），而 pnpm ≥10 默认不运行任何依赖的生命周期脚本。所以第一次 `dsh plugin add` 会以 `[ERR_PNPM_IGNORED_BUILDS]` 失败，并把待决项写进该 profile 的 `pnpm-workspace.yaml`。把 `koffi: true` 写进 `allowBuilds` 意味着**允许该依赖的安装脚本在你的机器上执行**（不在 agent 运行的任何沙箱之内）——`koffi` 的脚本只做本地预编译。

两个实测过的坑（DSH `0.2.1-alpha.2`，tarball 来源）：profile 的 `pnpm-workspace.yaml` 可能**没有** `set this to true or false` 占位标记（直接补 `allowBuilds` 即可）；恢复后的 `add` 退出 0 也可能没把插件激活进 `dsh.profile.bundles`——检查该 profile 的 `package.json`，缺的话做一次 `remove` + `add`。诊断步骤见[故障排查](../troubleshooting/install-stops-at-build-approval.md)。

## 各安装来源的差异

- **npm / tarball**：预构建产物，插件本身不参与编译；首次安装需要 `allowBuilds`。
- **GitHub**：装的是源码，`add` 时由包内 `prepare` 脚本自动构建（直接转译 `src/`，不做类型检查），因此 `allowBuilds` 需要覆盖本包自身和 `koffi` 两项；不带 ref 会跟随 `main` 分支的最新提交，写 `#v0.1.16` 这样的版本 ref 锁住内容，`#semver:*` 这类 semver 范围则始终解析到最新 tag。
- **从源码安装**：pnpm `link:` 链接本地 checkout，依赖在本仓库已装好，无需 `allowBuilds`；需要先 `pnpm build` 生成 `lib/`（未纳入 Git）。

用源码仓库跑 DSH 时 `dsh` 不在 PATH 里，把命令里的 `dsh` 换成 `pnpm dsh`。

## `/workspace-folders` 命令的完整语义

命令是文本入口，headless 组合下同样可用；子命令为 `list` / `add` / `remove` / `alias` / `access` / `reveal` / `isolate-profiles` / `help`，`/workspace-folders` 不带参数等同 `list`。

`/add-dirs [absolute path] [--inherit|--read-only|--read-write]` 是 `/workspace-folders add` 的别名，添加一个附加根；路径解析、权限选项、目录选择器、校验和结果均复用原命令，包括错误文本中的 `/workspace-folders` 前缀。它通过同一个命令注册表提供给客户端，不接管 dsh-TUI 的内置 `/add-dir`。

- `add` 不带路径时打开系统目录选择器（组合了目录选择器的 profile 才有），也可以 `add --read-only` 只给 flag 不给路径。
- 路径可以带引号，`~` 会展开为家目录；登记前会先 canonical 化——与已有根重复、嵌套在已有根内部、或就是主根本身的路径会被拒绝。
- `remove` / `access` / `alias` / `reveal` 的参数接受 `序号|路径`（序号即 `list` 输出的编号）。
- `alias` 不带别名参数会清除已有别名。
- `access` 支持 `inherit` / `read-only` / `read-write`；扩权变更要求该根此刻可用，具体方向见 [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)。
- `list` 如实显示每根状态：`missing`（暂时不存在）、`redirected`（被替换成指向别处的符号链接）的根**保留登记但暂不授予**；目录恢复后执行一次 `list` 或刷新面板即自动重新授予，无需重启。
- `isolate-profiles` 是宿主侧维护命令（面板没有对应端点）：默认**只读检查**——列出 `$DSH_HOME/profiles/` 下每个确认 profile 的 `packageImportMethod` 状态，并对整个 home 做一次扫描，报告 `scanned N dirs/M files, K multi-link files, J uninspectable`；存在无法检查的条目时结论为 INCOMPLETE，不能当作干净。`--apply` 把 `packageImportMethod: copy` 原子写入每个可修复 profile 的 `pnpm-workspace.yaml`（缺失则建文件，标量值原地替换、注释与换行风格保留，复杂/冲突/不可读文件拒绝改写）。Windows 上 deny ACE 写在文件对象而非链接名上——profile 依赖若以硬链接引入（pnpm 默认），对 `$DSH_HOME` 下 deny 会改写全局 store 中被共享的对象；该命令即是受限 Full-access 预检拒绝时指引的修复入口。它只改配置：**既有硬链接在按报告步骤退出宿主、删除 profile `node_modules`、按 lockfile 重装之前仍是硬链接**；它不修复 Administrators 属主或此前写到 store / 其他项目的 deny ACE，也不做全局 ACL 重置。命令不删 `node_modules`、不替你运行 pnpm，新建的 profile 也要重新检查或再跑一次。
- 命令的输出文案为英文（host 侧没有活动语言信息）。

## 访问级别、数量上限与 per-tool 封顶

面板同时显示登记策略与宿主派生的当前有效权限，并注明工具写入封顶；继承与固定读写之间的切换均需确认。目录失效只撤销授权，不解除仍登记的只读边界。两条登记的授权目录互相重叠时（含已失效目录的登记边界），双方都不授予成员资格，但各自登记的拒写边界仍然生效，调整列表顺序也不能解除——移除其中一条登记即可修复。

两个 DSH 进程共用同一 storage root 时，只有持有注册表 lease 的进程能读到登记表。另一个进程的空根表不代表「没有限制」：在它接管 lease 或存储恢复前，Full-access 与 workspace-write 均只授予主根写权限，不授予共享系统临时区；read-only 继续拒绝写入。显式拒写边界仍优先于主根授权。

B9 开发分支中，新根默认 `inherit`（继承会话模式）；`add --inherit|--read-only|--read-write` 或面板可显式选三档。显式只读保持完整成员资格，但 Full-access 也不得写——唯一例外是用户针对单次调用批准的 `danger-full-access` 一次性提权：它只解除该调用的只读根与 per-tool 封顶拒绝，`$DSH_HOME` 与 Registry 失权降级照旧（[ADR-0036](../decisions/ADR-0036-approved-escalation-override.md)）；固定读写在全局只读会话仍可写该根。旧可写记录升级为 inherit，重新登记保留原策略。重新登记只能恢复到该登记原本授权的目录：登记目录被替换（`redirected`）后，需要先移除旧登记再显式添加新目录；`$DSH_HOME`、Registry 存储目录及其祖先/后代不能登记（[ADR-0027](../decisions/ADR-0027-revive-target-and-protected-paths.md)）。权限与迁移合同见 [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)；已启动的进程与持久终端保留启动时的 deny 集——一个在某根变为只读之前启动的终端保持不受限，直到重启——变化只约束之后的调用与新进程。发布包是否包含 B9 见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)。

两条边界值得单独知道。**受限的 Full-access 同时保护整个 `$DSH_HOME`**：只要存在任何拒写边界（登记的只读根、工具封顶成员，或注册表权限不可用），home 目录（`~/.dsh` 或 `DSH_HOME`）也进入 deny 集——存根存储、注册表 lease 与配置文件都在其中，ambient 进程不许碰；零附加根且注册表健康时 Full-access 与上游逐字节一致。主根落在 `$DSH_HOME` 之内时 deny 胜出，该工作区在 Full-access 下不可写。**本插件永不约束你的面板终端**：进程围栏只给 env 带 `DSH_PTY_SESSION_ID`（agent PTY 由 terminal-bash backend 盖章）的 spawn 加前缀；面板 controller 的终端没有该标记，属于用户行为，任何模式直通。这个标记是启动时的兼容性断言而非假设：装了 `dsh-terminal-bash` 却探不到该常量时插件拒绝加载，避免新后端让 agent PTY 被当成用户终端。

Windows Full-access 的局部拒写独立 runner 通过管理员安装的 broker 赋予暂停子进程普通 deny-only 组 token，读回验证后恢复执行；缺少可信 broker 时拒绝启动。Windows ACL 继续报告 partial；其 token 与 ACL 合同见 [ADR-0020](../decisions/ADR-0020-windows-normal-deny-groups.md)。无法表达的后端组合拒绝启动，不退回裸进程；具体后端限制见 ADR-0017。

每个主根的附加根数量有上限（默认 16，经注册表行配置 `maxAdditionalRoots` 可调至 64）；超限的新增被拒绝，历史超限记录仍保留其登记授权；Windows Full-access 新进程另有有界拒写集容量，超限时整次启动被明确拒绝，见 [ADR-0020](../decisions/ADR-0020-windows-normal-deny-groups.md#协议容量与安装回滚修订2026-10-15)（[ADR-0014](../decisions/ADR-0014-root-limit-and-provider-conflict.md)）。

宿主还可以在 `multi-root-scope` 行配置 `toolAccess: { <工具名>: 'read-only' }`，让某个工具永远不能写任何附加根（例如 `{ bash: 'read-only' }`——bash 仍可写主根）；非法配置 fail closed。

## Worktree 附加根建议的完整语义

**激活门禁**：只有 `<primaryRoot>/.git` 本身存在（普通目录，或带 `commondir` 的指针文件）时才启用。仓库子目录、普通目录、伪 `.git`/伪 admin、submodule（两种形态）、bare 派生、`--separate-git-dir` 主 checkout、`include`/非空 `core.worktree`/`extensions.worktreeConfig`/`relativeWorktrees`、版本 1、split/sparse index、UNC/设备路径、symlink/FIFO 元数据都 inactive。首次门禁失败返回 `unactivated`：不建候选、不挂 watcher、不写 sidecar、不后台重查；只有面板/命令 list 或新的显式 wait 能重新尝试。曾经 active 后复验失败返回 `lost`，同样停止后台活动；primary 恢复后仍须显式触发，旧提示 ID 作废。

**发现与身份**：只枚举 `<common>/worktrees/*/gitdir`，不运行 `git worktree list`。候选必须属于同一 common、admin 在 `common/worktrees/<id>` 下、`.git` 文件与 admin 的 `gitdir` 双向一致、admin/common HEAD 通过语法校验且 common 结构有效。候选身份是 `adminId + canonical root + canonical admin gitdir target`；同一 workspace 的多个 session 共享 inventory、去重与 watcher，展示按 session 的 mode 过滤。只读会话可以处理 B（登记策略始终 `inherit`），Full-access 不提示。可见候选恰好一个时返回 `prompt`（原确认对话框），两个及以上返回 `prompts`（可勾选列表）；`seenViewRevision` 是唯一的已展示游标。

**提示与确认**：确认对话框显示实际路径、当前有效权限、`inherit` 与 workspace 级持久性；勾选「不再提示」写入 sidecar，对该 workspace 的所有 session 生效。确认走 Registry owner 的 `addNew`：owner 在串行队列内重跑完整 primary/candidate 判据、HEAD 语法、祖先 gitlink 与目录身份，只有全部一致才写；只新建，不 revive，不存在同路径记录。`duplicate` 视为已登记并停止提示，但不写清理映射。

**删除与清理**：删除信号（admin 消失、路径缺失、admin `gitdir` 指向新路径）只决定徽标。清理资格只看 `record.path` 是否确认缺失，并绑定 `rootId + path + addedAt`；路径存在、不可访问、或 checkout 仍有效时返回 `worktree/not-eligible`，面板只提供普通 Remove。批量清理只接受面板列出并显式确认的精确 id。**永不在删除事件上自动调用清理**。缺失根继续占额度。清理前同路径新目录可能继承旧授权，这是已记录的 L4 残余，面板会提示。

**持久化与降级**：`worktreeRoots` 与 `ignored` 保存在 `$DSH_HOME/storages/multi_root_workspace.worktree-prompts/<sha256(primaryKey)>.json`，只有持有 store lease 的 Registry owner 写入，follower 通过认证 IPC 请求。prune 只消费 owner 队列内的完整 `RegistrySnapshotView`：`available=false` 的空列表保留映射，`available=true` 的空快照才允许删除；跨 epoch 按 `rootId + path + rootAddedAt` 重绑或修剪。sidecar 损坏/不可写时 owner 退化为 memory-only 并告警，不影响授权；B 根按手动根处理，专用清理拒绝。

**设置**：`multi-root-worktrees.enabled` **实验性、默认 `false`**，与附属根 Skills 共用同一张插件详情设置卡但独立生效；标题旁显示“实验性”Tag，只有显式持久化 `true` 或 loader `true` 才启用，缺失 Settings 视为关闭。关闭后当前 Host 停止发现、watcher、后台重查与专用清理，唤醒 waiter 并作废旧提示；新的 worktree 请求返回 `worktree/not-enabled`，客户端停止重挂（`session-not-found`/`not-available` 这类瞬时失败会有限退避重试，不再要求先打开面板）。重新开启后按当前 live session 重新探测；此前已 `lost` 的 workspace 仍需显式恢复。已确认的普通 Registry 根与 sidecar 决定保留。

**A：主 checkout 授权。** 当 session primary 本身是 linked checkout 且处于 `workspace-write` 时，提示把**主 checkout 根 `<main> = dirname(canonical common)`** 登记为 `inherit`；`<main>/.git` 随主根一起授权。候选要求 `basename(common) === '.git'`、`<main>/.git` 是真实目录且 canonical 等于 common，并记录主根与 admin 身份；来源是同一份 primary 快照。对话框必须说明范围：主 checkout 源码树、共享 config、hooks、refs/objects 与所有 worktree 的 admin 数据，可能影响同一仓库的其他 checkout；登记是 workspace 级。**默认 pool 的主根包含 primary，`primary-overlap` 使其没有 A**；外部 linked checkout 适用。`--separate-git-dir` 时推导路径可能是 store 的父目录而非真正主 checkout，对话框显示实际路径并提示核对。等待期间 primary/admin/common 的 `dev/ino`（可用时含 birthtime）、admin HEAD、双向指针、祖先索引、主根身份或 `<main>/.git` 替换都会 `prompt-stale`。A 根没有 sidecar 清理映射：linked checkout 被删除不会触发清理，普通 Remove 即可撤回；专用清理只追踪 B 根。模式变化/关闭开关会作废旧提示；已提交的普通根不会因关闭开关回滚。受限 Git 旅程在真实内核沙箱下验证：授权前 `git add` 失败，授权后同一 `workspace-write` 完成 `add`/`commit`；主 checkout 源码现在在授权内，无关目录仍拒写；无可用 runner 时按既有 `kernel:probe` 规则 skip 并打印原因。

## 组合里实际发生了什么

`dsh --profile web --dump-config` 的输出是按 bundle 分组的 YAML 行数组（每行 `id` / `name` / 可选 `disabled` / `config`），`# == <bundle>` 注释行标记来源、`patched by` 标记被 patch。装入本插件后的差异是：

- 上游 `fs-sandbox` 与 `sandbox` 两行打上 `disabled: true`；
- 末尾追加 `# == @dsh-electron/dsh-plugin-multi-root-workspace` 段的全部 `multi-root-*` 行（compat 门禁、fs、sandbox、providers 冲突检测、scope、registry、instructions、lsp、workspace-files、process-fence、command、client 载体行）。

`bash-sandbox` 保持上游：受限模式经 `ctx.sandbox` 取根；Full-access bypass 由 `multi-root-process-fence` 包装 shell / PTC / PTY 的公开入口，按同一 scope 应用只读限制。插件只做 out-of-tree 扩展，不修改上游任何包。

## 模型侧与面板侧的行为

- 附加根拓扑经 `systemPrompt.context` 贡献注入系统提示词（授权变化时重渲），同一 Session 原始项目不变、切换执行目录不改变授权；无需新增内省工具。
- 附加根自身的 `AGENTS.md` / `CLAUDE.md` 也会进入模型上下文：根目录顶层的在会话第一步之前注入，子目录的在本会话成功触碰过该目录之后注入（上游的原生发现从会话 cwd 向上走，永远到不了附加根）。
- 面板侧：工作区目录面板将主根标为「主要工作目录」，并在当前 Agent 工作目录所属的根别名旁显示「当前Agent工作目录」标签；子目录向上匹配最近的列表根，未命中则不显示标签。权限选项「工作区内修改」「仅可查看」沿用上游权限菜单的图标与文字，分别表示固定读写和固定只读，「跟随会话」仍继承会话权限。插件管理页的附属根 Skills 总开关使用上游 Switch，保留各目录的独立选择。目录行不展示 Skill 命名空间；右侧「文档＋星芒」图标按钮控制该目录的技能启用状态，启用时显示完整图标、停用时加斜线，按钮仅在悬停或按下时显示背景，悬停提示状态与下一步操作。面板保存期间保留按钮外观与焦点，阻止重复操作；技能状态仅在宿主确认保存后更新，保存失败时保留原状态并显示错误。侧栏底部 **Folders** 动作打开对话框；DSH `0.2.1-alpha.3` 起，新会话页工作区行右端（`conversation.hero.options`）也有同一入口——它与相邻的工作区/模式选择器同几何、无 chevron，`≤560px` 视口下只显示图标，旧运行时只有侧栏入口；两处打开同一对话框、走同一套 RPC。工作区行的 `...` 菜单（以及工作区行的右键菜单）也有「管理工作区目录…」：当前会话已属于该工作区时直接打开；否则先打开/复用该工作区的空白页，确认它成为当前会话后再打开并固定到该会话，导航失败或被后续切换取代时不弹窗，所需服务缺失时该项置灰。Files 页签的根选择器可以浏览附加根（选中时树区由原生的复刻视图接管，切回主根恢复原生）。面板文案中英双语跟随界面语言。

B9 Windows Full-access 局部只读需要管理员安装随包提供的特权 broker（[安装与安全边界](../decisions/ADR-0020-windows-normal-deny-groups.md#安装与卸载)）；插件不会自动提权。子进程是 Store/MSIX 版应用（如 WindowsApps 别名下的 `pwsh.exe`）时该组合会拒绝启动并给出诊断——打包进程携带 minted deny token 无法保留的包身份；请安装 MSI/ZIP 版 PowerShell（或使用其他非打包可执行文件）并让它排在 WindowsApps 别名之前。升级插件后需用 `install.ps1` 重装一次 broker，新的调用方规则才会生效。Linux 同组合需要可执行的 bubblewrap，即使普通受限模式选择的是 Landlock：上游选定 Landlock（说明 bwrap 不可用——未安装或禁用非特权 user namespace）的主机上，携带任何拒写边界（显式只读根或受限 Full-access 下受保护的 `$DSH_HOME`）的 Full-access 命令在启动前就失败关闭；要使用该组合请安装并启用 bwrap，或避免在这类主机的 Full-access 下登记显式只读根。依赖缺失会报告 runner 不可用，不能作为允许裸启动的理由。
