# Changelog

本文件记录每个**已发布**版本对使用者可见的变更。

English: [CHANGELOG.en.md](./CHANGELOG.en.md)

- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
- 安装方式、受支持的上游运行时与已知限制见 [README](./README.md)。
- 每个版本的实施证据、编号口径与发布状态见[路线图 §进度总账](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账)；GitHub Release 的正文由 `scripts/release-notes.mjs` 从 commit 历史生成，是本文件之外的完整原始清单。

## [0.1.24-beta.2] - 2026-11-23

本版是 `0.1.24` 线的第二个 beta，只处理启用个人 SSH 后的依赖准备与 Helper 安装诊断。开启 SSH 时若当前 Profile 的四个 SSH 包未就绪，界面直接给出可复制的精确安装命令；Helper 安装失败会说明失败阶段、远端状态与下一步。没有不兼容变更；未开启 SSH 时行为与 `v0.1.24-beta.1` 相同。

### Added

- **SSH 依赖修复引导**：Host 在 SSH 开关开启后检查当前 Profile 中的 `@deepseek-ai/dsh-ssh`、`@deepseek-ai/dsh-fs-ssh`、`@deepseek-ai/dsh-subprocess-ssh`、`@deepseek-ai/dsh-sandbox-ssh` 四个精确同版包，把全部缺失、部分缺失、版本不符、私有副本、无法解析与「已安装但需重启」分开；未就绪时自动打开「安装 SSH 依赖」对话框（也可从「管理 SSH 远端」进入），逐包显示状态，并在 Profile 由 CLI 管理时给出 `DSH_HOME=… dsh plugin --profile <name> add --save-exact <四个包>@<Host 版本>` 命令与复制按钮。「重新检测依赖」只读取状态，运行中的 Host 不替用户运行包管理器；依赖装好后仍需完全退出 Host、以同一 Profile 重启，刷新 Web 页面不等于重启。
- **Helper 安装诊断**：安装失败归入 `host-preflight`、`ssh-connect`、`remote-prerequisites`、`remote-install`、`artifact-verification`、`entry-generation`、`config-commit` 之一，并携带是否可重试、修复方向、退出码、受限的 stderr 摘录、期望/实际版本、远端状态（`may-have-changed` / `installed` / `verified`）与登记状态（`not-committed` / `unconfirmed`）。连接页在瞬时提示之后保留可展开的详情，区分「远端可能已改动」「远端已安装或已校验但 Host 未登记」等需要人工核对的情况；OpenSSH 退出 255 只识别标准的 host key、认证、不可达、超时与中断诊断，无法识别时单独归为未知错误，远端写操作绝不因诊断自动重发。

### Changed

- **Helper 前置条件在首次远端写入前检查完**：远端必须是 Linux 或 macOS，Node.js ≥ 24.9.0 且为规范化绝对路径，npm 可运行，`$HOME` 与 `~/.dsh-helper/<版本>`（或最近的现存父目录）可写；远端 PATH 选中旧版 Node 时可在连接卡片的安装表单里指定新版 Node 的绝对路径。`npm install` 仍只执行一次且不重试，入口脚本以 0600 临时文件加原子改名部署，安装结果与 Host 登记结果分别确认。

## [0.1.24-beta.1] - 2026-11-22

本版是 `0.1.24` 线的首个 beta 预发布：SSH 远端环境以实验性、默认关闭的个人模式进入发布包，另含 Workspace Folders 对话框附加根列表的滚动修复。没有不兼容变更；未配置附加根、未开启 SSH 时，行为与 `v0.1.23` 相同。

### Added

- **SSH 远端环境（实验性，默认关闭）**：Issue #32 的首个发布形态，只开放个人 SSH。插件详情设置卡中的开关（`multi-root-remote-tools.enabled`）默认关闭，首次开启需确认风险；关闭后卸载远端工具、以取消信号收束在飞操作并关闭远端控制面。连接与 Workspace Root 绑定分开管理：连接（主机、端口、账号、平台、主机指纹、凭据引用、Helper 与执行/传输能力上限）保存在插件级 `remoteEnvironments.personalPath`（默认 `$DSH_HOME/storages/multi_root_workspace.remote-personal.json`，schemaVersion 2），Workspace 绑定保存在同名 `.bindings.json`，同一 Workspace 可在同一连接上绑定多个互不重叠的远端目录。两份文件都要求当前 uid 的普通文件、非符号链接、权限至多 0600，父目录不得由 group/other 写，位置须在所有绑定的本地主根之外；每次 snapshot/list/admit/add/remove 前复核保护与内容，并发变更由内核租约 + CAS 串行化，多 Host 不丢记录。凭据根（默认 `$DSH_HOME/storages/multi_root_workspace.ssh`，0700）保存生成的密钥、导入的私钥、`secrets/`、托管的 `ssh_config` 与 `known_hosts`，任何端点都不返回私钥或密码字节。主机密钥经 `ssh-keyscan` 或本机 known_hosts 核对后以 60 秒令牌确认；托管连接在 `~/.ssh/config` 首行写入 `Include`（先备份、幂等；`~/.ssh/config` 是符号链接时写到解析目标、绝不替换链接），未链接时连接报 `ssh-config-not-linked`。Helper 安装按包内 `lib/*` 与安装后的文件集摘要校验，早于 `integrity: 2` 的 Helper 需重装；托管密码先经 0600 一次性口令文件与 `SSH_ASKPASS` 安装访问密钥，失败按目标回滚或返回 `access-key-reconcile-required`。本机 `~/.ssh/config` 的字面 `Host` 别名可直接选用，通配与否定项被跳过。
- **`remote_copy`：三个方向的单文件传输**：本机 → 远端（SFTP staging）、远端 → 本机（目标父目录内 0600 独占 staging）、远端 → 远端（Host 中继，两端同时准入）。传输前绑定源 inode 并复核 realpath、普通文件、大小与 mtime，按分块读取；写入前累计校验 `maxBytes`，源在绑定后增长也以 `transfer-too-large` 拒绝，不会先把超限字节写到 staging；回读校验字节后以原子 no-replace hardlink 发布。应答丢失返回 `unknown` 与 reconcileId，绝不重试；清理只碰本次操作的 staging，且仅在同一会话代次仍存活时进行。`transfer.timeoutMs` 是涵盖准入、握手、读写、校验与发布的整次预算；每个复制端点独占一条 SFTP 通道，清理使用独立的一秒预算。
- **`remote_bash`：两阶段准入的远端命令**：一次准入用于验证与 confine，第二次准入内才 spawn，撤权或后端代次变化不会漏到启动；从 spawn 返回 handle 起观察取消、超时与授权变化（owner 通知 + 每秒复核，单轮无结论 5.5 秒截止）。结果区分 `not-started` / `may-start` / `exited` / `scope-exited` / `unknown`，终止原因 `revoked | cancelled | timeout`；`terminateGraceMs` 内无法确认时返回 `unknown` 与 reconcileId，不无限等待、不重放。执行与传输独立授权，命令准备前拒绝重定向目录与越界 cwd。
- **SSH 管理界面**：插件详情的「SSH 远端」经独立的 `/multi-root-workspace-ssh-settings` Connection 通道打开，连接与 SSH Key 分页管理，绑定仍走 `PANEL_CHANNEL` 由当前会话派生主根；「添加连接」是两步向导（连接 → 连接设置），Workspace Folders 新增「远端工作目录」与绑定向导，和主要/附属工作目录共用行形态，地址为可复制的 `ssh://user@host:port/path`。异步请求以原位转圈、`aria-busy`、延迟淡入的状态行与顶部进度条反馈，会改写配置的请求按 revision 串行。面板、插件详情页与预览的 8 份语言词典同步补齐 SSH 文案，键集、键序与占位符由 `tests/locale-parity.spec.ts` 钉住。
- **SSH 兼容门禁**：`@deepseek-ai/dsh-ssh`、`dsh-fs-ssh`、`dsh-sandbox-ssh`、`dsh-subprocess-ssh` 作为可选 peer（peer range 与核心 allowlist 相同），运行时经 `src/compat/ssh-packages.ts` 从宿主锚点按需加载，绝不静态导入；`SUPPORTED_SSH_RELEASES`（`0.2.2-rc.1`–`0.2.2-rc.5`）必须是 26 个精确发布 allowlist 的后缀。SSH 包缺失、漂移或私有副本只让 SSH 能力缺席，不改变本地兼容判定；`pack:check` 拒绝静态 SSH 导入与打包后的 SSH broker 入口。

### Changed

- **新增集成默认不改变既有行为**：SSH 行随 bundle 挂载，但 `enabled: false` 时不注册远端工具、verifier、能力投影或 profile guard，Registry 的远端控制面保持 `disabled`；`team` / `hardened` / broker 档位按停用处理，发布包移除 broker 入口与安装脚本，相关设计与探针只留作研发记录。

### Fixed

- **Workspace Folders 对话框的附加根列表在根多、窗口矮或行换行时被裁掉**：对话框此前没有窗口相对的封顶，附加根区也不滚动——16 个根加数量上限提示、或窄宽下批量操作标题换行时，行被裁在区域里、添加控件被挤出可视区。现在对话框封顶 `min(80vh, 100%)`，附加根区先让高、行列表取剩余空间并在原位滚动，主根行、两个分区标题与添加行保持固定；列表最小高度取最高一行实测高度（`--mrfw-root-row-height`，空列表为 0，无法测量时回落 70px），保证至少一整行完整可见；视口过矮时由对话框 body 接管回退滚动，滚轮在列表末端交给 body，页脚与添加控件始终可达。正常高度下的对话框尺寸与滚动行为不变。

## [0.1.23] - 2026-11-19

### Added

- **面板、插件详情页与预览插图覆盖 DSH 内置的全部 8 种界面语言**：面板文案此前只有中英两份，现在 DSH 客户端的 8 种界面语言（`zh`、`en`、`ja`、`es`、`fr`、`de`、`ru`、`pt`）各有一份词典；中文是 canonical，其余 7 份用类型约束钉住键集与 `{count}` / `{access}` / `{tools}` 等占位符，8 份在一次 `ctx.locale.register` 中注册。插件详情页补齐本地化的 `meta.title` / `meta.description` / `meta.detail` 与 6 种新语言的 `DETAIL.<lang>.md`、`preview.<lang>.svg`；预览插图由 `pnpm preview:gen` 从同一份版式生成，文字转曲、按语言选择字体、按槽位实测宽度收缩，缩到下限仍溢出就直接失败；入口药丸改用侧栏动作的短标签，长译文不会再压住卡片标题。更早的宿主只显示它自己内置的语言，新增词典作为惰性资源存在，不改变其语言菜单。
- **仓库根 README 扩展到 8 种语言，并新增逐功能用户指南**：README 现与 DSH 客户端的 8 种界面语言一一对应（中文 canonical，其余 7 份互链并保持同一标题层级与代码块语言），`docs:check` 会逐份校验；`docs/guide/user/` 新增中英双语的命令、访问级别、附加根 Skills、Worktree 建议、Auto Review、界面入口与模型上下文指南。
- **贡献与安全治理文档**：新增中英双语 `CONTRIBUTING` / `SECURITY`、PR 模板与 bug / feature issue 表单；`THIRD_PARTY_LICENSE` 从声明的依赖、构建出的 client source map 与入库的上游复刻清单生成，并纳入 `pack:check`、开发 pin CI 车道、`verify:all` 与发布流程的校验。

### Changed

- **精确支持 DSH `0.2.2-rc.5`**：支持矩阵扩至 26 个精确版本，开发 pin 提升到 `0.2.2-rc.5`（cordis `4.1.0` / Schemastery `3.19.0`）。`rc.5` 只有 5 个提交、433 个文件，其中 380 个 manifest 仅替换版本号；净改动是 DeepSeek 内置联网搜索按模型请求的路由选择搜索 provider（`dsh-web`、`dsh-tool-web`、`dsh-web-search-deepseek` 与设置卡片），以及上游文档、e2e 与会话快照。插件消费的沙箱、fs、session、storage、client 与 reviewer 源码逐树未变，因此未新增适配分支，open-in-app 与 files-tree 的复刻基线保持不变；可选 Auto Review 联合合同纳入 `rc.5` 并把 current 编译 pin 前移到它（reviewer 源码树与 `rc.4` 逐字节相同），联合集合扩至 11 个精确发布（[接口审查](./docs/reference/dsh-0.2.2-migration.md#022-rc5-后续审查2026-11-18)、[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。

## [0.1.22] - 2026-11-18

### Added

- **Files 页头的根名按实测宽度分三档显示**：窄栏、右栏双栏与浮动小窗下，触发器不再只靠 CSS 右省略，而是按自身宽度依次显示完整根名、「前几个…后几个」、「开头…」。中间档自适应地最大化可见字符，并优先在 `-`、`_`、`.`、空格、`/` 处断开，让同前缀不同结尾的根（`…-workspace` / `…-experiment` / `…-ssh`）仍可区分。判定输入是与文字内容无关的 switcher 宽度，文字变短不会反向改变判定；`open-in-app` 按钮异步插入后同样重拟合。完整显示名始终在 `aria-label`（[ADR-0046 修订](./docs/decisions/ADR-0046-files-header-rootswitch-shrink-priority.md)）。

### Changed

- **精确支持 DSH `0.2.2-rc.4`**：支持矩阵扩至 25 个精确版本，开发 pin 提升到 `0.2.2-rc.4`（cordis `4.1.0` / Schemastery `3.19.0`）。`rc.4` 只有 8 个提交，其中 380 个 manifest 仅替换版本号；净改动是 DeepSeek 内容安全审查拒答（共享 `dsh-llm` 新增 `LLM_FAILURE_CODES.CONTENT_REFUSED`，由宿主拥有，插件不按 LLM 错误码路由）、实验包 liveshare 的 tunnel worker 修复，以及上游文档与会话快照。插件消费的沙箱、fs、tools、session、storage、client 与 reviewer 源码逐树未变，因此未新增适配分支，open-in-app 与 files-tree 的复刻基线保持不变；可选 Auto Review 联合合同纳入 `rc.4` 并把 current 编译 pin 前移到它（reviewer 源码树与 `rc.3` 逐字节相同），联合集合扩至 10 个精确发布（[接口审查](./docs/reference/dsh-0.2.2-migration.md#022-rc4-后续审查2026-11-18)、[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。

### Fixed

- **Files 页头 `RootSwitcher` 在窄宽下压住相邻控件**：页宽 299px 时触发器与 reload、搜索各重叠 28px，与 `open-in-app` 重叠 14.59px；浮动面板宽 220px 时 `open-in-app` 被整枚覆盖。根因是收缩能力写在了内层按钮上：真正参与 header 外层 flex 的是 `Menu` 渲染的 anchor 包装，默认 `min-width: auto` 把宽度钉在根名的 min-content（实测 249.59px），路径压到 0 后已无别的让位者。现在按「固定控件 → 完整路径 → 根名 → 触发器图标」的优先级让位：reload / 搜索 / `open-in-app` 保持原生几何永不移动，路径以零 basis 先让到 0，anchor 解钉后根名省略，最后才裁剪触发器图标。ADR 撰写时 24 个受支持发布的 `Menu.className` 逐 tag 核对，规则无版本分支（[ADR-0046](./docs/decisions/ADR-0046-files-header-rootswitch-shrink-priority.md)）。

## [0.1.21] - 2026-11-17

### Added

- **附加根文件预览导航树的工作区搜索**：预览文件位于附加根时，右侧 Folder 导航树此前只能浏览、不能搜索（原生搜索根固定为会话 cwd，接管期被插件隐藏）。本轮复用 Files 页唯一的工作区搜索面与同一个 `search` 端点，为 `FilesPane` 增加 preview 模式：搜索栏常显、命中高亮结果树、被预览文件在结果中标为当前行、点击结果以 `replaceTab` 原位替换预览、关闭设置回焦搜索钮、↑/↓ 在输入、树行与结果行之间移动、Escape 依次关闭设置 → 清空查询 → 交给原生关闭导航树；搜索记录按 pane + 根键控，body 重挂载与 `replaceTab` 后保留展开与滚动。宿主零改动（`workspaceFiles.search` 自 `0.2.2-rc.2` 起；更早宿主与主根预览保持原样）（[ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)）。
- **Files 页被第三方整页接管时的可见提示（Issue #47）**：第三方插件以 `priority: "extension"` 注册 `files` kind 时，宿主不再渲染内置 Files 页，根切换器的 seat 永不挂载，此前用户只看到「插件没生效且没有提示」。现在插件读取 `ctx.sidebarRightTabs.get('files')` 的生效定义（声明 band + 实现 id 的结构探测，不比较版本字符串），确认被接管时弹一次官方 info 级瞬时 Toast（无警告图标、约 5 秒淡出），说明根切换器暂不可用、根管理仍可从侧栏「工作区目录」与 `/workspace-folders` 完成；同一接管实现只提示一次，接管解除后重新武装。服务或定义缺失时按「无接管」静默，旧宿主不提示。
- **Worktree 提示的圆形关闭按钮**：收回第二十一次修订「删除 ×」的决定，常驻提示右上角加回 18px 正圆关闭按钮（自绘控件、0.5px 描边、圆心相对卡片角点内收 2px、24px 命中环、悬停不变色、仅有 `:focus-visible` 品牌环）。语义为纯关闭：不调用 `snooze` / `resolve`、不写 sidecar 与 Registry，本 Host 生命周期内不再自动提示、Host 重启后候选重新可见——与写持久延迟的「稍后提醒」和写 ignore 的「永久不再提示」三分（[ADR-0039 第二十五次修订](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md#第二十五次修订2026-11-15)）。

### Changed

- **`koffi` 改由宿主提供（可选 peer），npm / tarball / 本地路径安装不再需要构建授权**：插件不再在 `dependencies` 中携带 `koffi`（Windows Registry Authority 与 Worktree Git 元数据读取的 FFI 封装），改为 optional `peerDependencies` 加 `devDependencies` 开发 pin。pnpm 不会安装可选 peer，因此首次 `dsh plugin add` 不再停在 `[ERR_PNPM_IGNORED_BUILDS]`，profile 的 `pnpm-workspace.yaml` 也不需要 `allowBuilds: koffi`。运行时 `loadHostKoffi()` / `loadHostKoffiSync()` 依次尝试 `DSH_KOFFI_PATH`、`dsh-fs-local` 锚点、宿主入口与 DSH Desktop 的 `app.asar` / `app.asar.unpacked` 运行时目录，只加载宿主那份副本，避免第二个 `koffi.node` 镜像在 darwin-arm64 上触发 SIGBUS；找不到时明确报错，不再回退到包内副本。git 来源仍需为插件自身的 `prepare` 授权（[ADR-0007 修订](./docs/decisions/ADR-0007-registry-authority-lease.md)）。
- **Workspace Folders 面板的 Worktree 清理 UX 收敛**：批量清理入口从 footer 移到「附属工作目录」标题行；删除确认由 body 顶部的内联文字改为覆盖面板的宿主 `Modal`（单行与批量共用，单/多分别披露路径复用，独立错误归属，请求中关闭不撤销，成功只清本次 id 数组）；`cleanupEligible` 行收敛为名称 + 权限徽标 + 路径 + 红色删除 + `…` 菜单（两条状态字、技能开关、reveal、重新登记与行内路径复用提示移出，披露移入确认层；其他 missing 行保持原动作）；手动发现无候选时弹官方 info Toast（自动检查与提示「查看」的竞态保持静默）；根上限提示独占 footer 一行，控件行位于其下。授权、清理资格、owner 复验与端点形状不变（[ADR-0045](./docs/decisions/ADR-0045-worktree-cleanup-panel-ui.md)）。
- **侧栏 footer 入口与宿主设置行逐像素对齐，并支持同槽共存**：footer occupant 的图标由齿轮改为 workspace tree（与 Hero、工作区菜单同族）；行几何改为「宿主 token + 旧值 fallback」的一份声明，在旧 19 个几何版本与新 5 个 token 几何版本上都与宿主设置触发行逐像素一致；按钮高度跟随可见设置行 occupant（`0.1.7-rc.2` 及更早 42px，`0.2.0-rc.1` 起未登录 32px / 已登录 44px，rail 36px，探针缺失回退 42px），hover 填充改用 `background-color` 长写以免 `background-clip` 被重置；rail 圆角按其更早的 `0.1.6-alpha.2` 分界取 12px（最老 2 个版本的宿主圆形是已记录偏差）；本入口挂载期间把 `sidebar.footer.action` 的 slot anchor 变成纵向列，使同槽第二个 occupant 各占一整行。未安装或未挂载时宿主布局原样（[ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)）。
- **README 重写功能概览并重组已知限制**：简介改为面向使用者的能力清单（权限真正生效、Files 页浏览、Skills、Auto Review、Worktree 建议、不登记等于没装），已知限制拆为「插件功能」与「OPS 适配」两节，并补充 Files 页接管提示、footer 行几何与 Worktree 关闭按钮的说明。

### Fixed

- **附加根搜索的两个 v0.1.20 遗留缺陷**：Files 页换根过渡帧会以新根的 `rootId` 发送旧根的查询/筛选，并把旧根记录留在 `pending`（状态行卡死、失败结果被清成无限 pending）；现在 `RootSwitcher` 与预览接管都把 `rootId` 并入按根原子落定的 takeover 记录。键盘焦点序列缺少列出的树行（Down 无法从输入进入首行、Up 无法回到输入），且设置草稿会跨根残留；两项随 preview 模式在同一搜索面修正。

## [0.1.20] - 2026-11-15

### Added

- **附加根 Files 对齐主根：行右键菜单与工作区搜索**：附加根文件树补齐主根原生的行级右键菜单——插件只提供 file/directory target 与触发绑定，菜单项来自宿主贡献方，target 传附加根绝对路径，因此宿主经 `workspaceFiles.stat` / `readBytes` 落到附加根——并新增插件自绘的工作区搜索：页头开关、搜索栏（排除规则、隐藏项、`.gitignore` 开关）、命中高亮结果树、空结果/截断/不完整提示与失败重试、↑/↓ 与 Esc 键盘操作，偏好按根写入宿主同名 localStorage 键。搜索走插件通道的 `search` 端点：会话派生主根、刷新 Registry 解析根 id、单次共享准入、帧内复核授权，结果受根边界约束。两个结构门控是 `useContextMenu`（DSH `0.2.2-alpha.3` 起）与 `remote.workspaceFiles.search`（`0.2.2-rc.2` 起）；更早宿主不绑定菜单、不渲染搜索 UI，附加根视图保持原样。评审修复同批交付：关闭设置浮层时提交排除规则草稿、请求身份复用使 body 重挂载不丢展开/滚动、上游 `workspace-file/*` 失败码原样透传、搜索记录按 session 拥有并在所有者死亡时清理、页头 reload 对非空查询重新取结果并保留位置（[ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md)、[ADR-0042](./docs/decisions/ADR-0042-additional-root-row-context-menus.md)）。
- **可选 Auto Review 联合支持扩至两代共 9 个精确发布**：联合合同从单一 `0.2.1-rc.2` 扩为两个冻结上游源码基线——`0.2.1-rc.2`–`rc.5`（legacy fork）与 `0.2.2-alpha.2`–`rc.3`（current fork）——每个基线各带逐字节上游副本、审阅过的 fork、编译 pin 与执行副本校验。Loader 入口按安装的精确发布动态加载对应基线的实现 bundle，另一代的导入不会进入宿主模块图；`0.2.2-alpha.2` 早于请求目的映射，保留该发布的官方请求形状（不发送 `sessionId` / `purpose`），`alpha.3` 起按上游发送。构建、类型检查、差分门禁、联合冒烟与 CI 车道均按基线运行（[ADR-0040](./docs/decisions/ADR-0040-auto-review-multi-baseline.md)、[接口审查](./docs/reference/auto-review-0.2.2-migration.md)）。
- **Worktree 确认 Dialog 重构与逐行权限选择**：Dialog 加宽到 `min(860px, calc(100vw - 48px))`，候选由独立卡片改为连续列表（行间细分隔线、无卡片描边、行内 hover），每行显示检测到的 Git 分支与登记访问级别选择器（默认 `inherit`，可逐行选 `read-only` / `read-write`），选择经线协议校验后记录进 Registry 的 grant；删除原有的 inherit 说明段，footer 改用 primitives `Button` / `Menu` 下拉。共享 Registry 部署下 follower 的 `addNew` IPC 现接受三档访问级别；复用候选记录时刷新主 checkout 的分支展示（`mainHead` 仍不参与授权）（[ADR-0039 第二十二次修订](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md)）。

### Changed

- **Worktree 发现收敛为「会话激活时一次只读检查 + 非模态提示」**：不再常驻长轮询。session 每次从空/其他会话变为有效会话时只调用一次 `worktreePrompt(..., { fresh: true })`——这是一次纯查询：不安装 watcher、不调度 owner reconcile、不写 sidecar；有候选则显示常驻非模态提示，只有点「查看」才打开确认 Dialog（此时才取全量候选并启动 wait），关闭 Dialog 不写任何状态。提示支持「稍后提醒」（直到出现新 worktree / 7 天 / 30 天）；Host 在内存中记录已展示的候选，并在每次自动检查前只读重读 owner 的提醒投影，多个 Host 的期限按 key 合并、只淘汰最旧的记录并释放认领。授权语义不变：不自动添加或删除，`addNew` 仍是唯一写路径，owner 仍完整复验（[ADR-0039 第二十次修订](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md)）。
- **Worktree 提示改为页面感知的居中卡片**：提示不再固定在右下角——Hero 页落在输入卡上方居中，对话页落在 Header 下方的内容列居中；表面随主题自适应（浅色模式浅色卡、深色模式深色卡，全部使用宿主 `--dsw-*` token），控件改用 primitives `Button` / `Menu`，删除「×」关闭按钮（「稍后提醒」本身就是关闭操作，拆分为文字按钮 + 下拉两半），粗指针或窄宽时改为两行 32px 形态，并在检测到官方瞬时 Toast 时临时下移避让；探针失败回落到 Hero 顶部居中，不再回到右下角。Workspace Folders 面板新增「Worktree 建议」手动入口，Files 页签打开的管理器也透传该入口，提示被关闭后仍可再次打开 Dialog（[ADR-0039 第二十一次修订](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md)）。
- **安装排查文档补充 DSH Desktop 插件页安装恢复路径（issue #57）**：说明插件页安装只写 `dependencies`、`dsh.profile.bundles` 由随后的「立即启用」单独写入，因此可能停在中间态；给出完全退出 Desktop 后用自带 CLI 执行 `remove` + `add` 并确认 `dsh.profile.bundles` 后再冷启动的恢复步骤，并记录「热启用会撞上仍在运行的旧 provider、冷启动不受影响」的结论（[排查](./docs/troubleshooting/desktop-install-missing-bundle.md)）。

### Fixed

- **新会话 Hero 入口不再把工作区行撑出输入卡**：入口此前按 label 全宽是纯加法（上游 `.heroOptions` 是 `flex: none`），列宽不足时越过输入卡右缘，视口媒体查询也不会因列宽变化触发。现在探针测量行内留给该组的余量，减去其他占用、间距与座椅内缩后以 `max-width` 夹取，label 省略号收缩；余量低于 88px 退化为 28×28 图标。探针能识别上游行结构与共享同一 slot outlet 的多个占用者；认不出结构时保持原视口回退形态，不报错、不空白（[ADR-0037 修订](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)）。
- **Worktree 提醒的跨 Host 与生命周期修复**：到期、淘汰、合并与残余记录都按延迟身份精确释放「已展示」认领，避免重复提示或永久隐藏；跨会话迟到的 `snooze` / `resolve` 完成不再覆盖新提示；`seen` / `snooze` / `resolve` 超过 64 个 id 时按批发送，响应列表不再被上限拒绝（[ADR-0039](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md)）。

## [0.1.19] - 2026-11-14

### Added

- **精确支持 DSH `0.2.2-rc.3`**：支持矩阵扩至 24 个精确版本，开发 pin 提升到 `0.2.2-rc.3`（cordis `4.1.0` / Schemastery `3.19.0`）。`rc.3` 相对 `rc.2` 的差异全部为新增：新会话行 HOC 槽、`workspace.picker` Factory 与第三个 directory-flow 洞、上传图标、默认不挂载的可选实验 bundle `dsh-deepseek-chat-import`、会话导出的附件缺失降级；插件消费的沙箱、fs、tools、session、storage、Skills、LSP、workspace-files 与 Connection 运行时源码均未变，因此未新增适配分支，open-in-app 与 files-tree 的复刻基线也保持不变（[接口审查](./docs/reference/dsh-0.2.2-migration.md#022-rc3-后续审查2026-11-13)、[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。

## [0.1.18] - 2026-11-12

### Added

- **精确支持 DSH `0.2.2-rc.2`**：支持矩阵扩至 23 个精确版本，开发 pin 提升到 `0.2.2-rc.2`（cordis `4.1.0` / Schemastery `3.19.0`）。`rc.2` 新增的 `workspaceFiles.search` 与插件已有的文件访问走同一共享 Registry 逐操作准入与根边界；上游在 Windows ACL 进程 profile 中改为忽略额外根（文件工具仍按额外根放行），插件以组合用例钉住该语义；未新增适配分支（[接口审查](./docs/reference/dsh-0.2.2-migration.md#022-rc2-后续审查2026-11-11)、[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。

### Fixed

- **Files 页签搜索遵守根边界**：`workspaceFiles.search` 与 `list` / `stat` / `read` 一样取共享 Registry 的 `files` 准入；搜索根（Session cwd）落在在册但未授权的边界下时，在启动 `rg` 前直接拒绝。`list` 与目录 `changes` 按路径解析后的所选目录判断，显式路径读取仍按词法规则。原生搜索没有附加根入口，接管附加根浏览时隐藏导航器新增的搜索条、状态行与页签搜索开关，避免展示主根结果；主根浏览与更早的受支持版本保持上游原样。

## [0.1.17] - 2026-11-11

### Added

- **Worktree 附加根建议（实验性，默认关闭）**：当主根本身是 Git main checkout 或 linked worktree 时，插件会发现与该仓库共享同一 common git dir 的其他 worktree——包括会话开始前就存在、由终端、IDE、forge 或其他 DSH 实例创建的——并在用户确认后把其源码树登记为 `inherit` 附加根。发现只读取插件自己打开并解析的 Git 元数据（`.git` 指针、admin、common 的 config/HEAD/index 与完整祖先链），**不启动任何 Git 子进程、不解析 commit 对象，也永不自动添加或删除**。可见候选恰好一个时显示确认对话框，两个及以上时显示可勾选列表并一次确认多个目录；登记是 workspace 级的，其他读写会话也会获得该目录的写权限，对话框会明确披露。worktree 被删除或移动后，面板显示徽标并只提供显式清理（要求登记路径确认缺失且 `rootId + path + addedAt` 仍匹配），缺失根继续占用 `maxAdditionalRoots`；submodule、bare 派生、`--separate-git-dir`、`worktreeConfig`、仓库格式版本 1 与 split/sparse index 等一律不提示。开关位于插件详情卡（与附属根 Skills 同卡、独立生效），默认关闭，关闭后已有登记根仍按普通根管理（[ADR-0039](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md)）。
- **Linked worktree 的主 checkout 授权（A）**：当 session 的 workspace 本身是 linked worktree 且当前为 `workspace-write` 时，插件还会提示把该仓库的主 checkout 根 `<main>`（共享 common 的父目录）登记为 `inherit` 附加根，补上受限会话执行 `git add` / `git commit` 的共享 Git 元数据写入缺口；对话框会显示实际路径与范围（主 checkout 源码树、共享 config/hooks/refs/objects 与所有 worktree 的 admin 数据）。提示只在完整快照证明 common 身份、双向指针、admin HEAD、主根身份与 `<main>/.git` 均一致时出现，等待确认期间任何变化都会以 `worktree/prompt-stale` 使该项失效。默认 pool 因 `primary-overlap` 不提供 A；`read-only` / `danger-full-access` 与关闭开关后不提示。A 根不进入 worktree 清理映射，撤回使用普通 Remove（[ADR-0039](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md)）。
- **新会话页工作区行的 Workspace Folders 入口**：DSH `0.2.1-alpha.3` 及更新的运行时上，blank session 工作区行右端（`conversation.hero.options`）新增 `工作区目录 / Folders` 入口。它与相邻的工作区/模式选择器同高、同字号、同 hover/展开底色，单击打开与侧栏入口同一个对话框（同一套 RPC、错误码与文案）；因为打开的是对话框而不是下拉菜单，它**没有 chevron**，图标使用 workspace tree（旧运行时回退 folder 字形），并按右对齐行的顺序把文字放在左、icon 放在右；右侧再补 4px，与工作区选择器的 20px 左内边距对称（图标/文字 ink 同为 28px）。该入口不 grow、不绝对定位，可与同槽其他条目并存。窗口宽度 `≤560px` 时只显示 28×28 图标，名称保留在 `aria-label` 与悬停提示中；`≥561px` 恢复文字并允许 label 省略号收缩。首条消息发出后 hero 行随整行消失，侧栏底部 `Folders` 入口与其行为完全不变；旧运行时没有该槽，注册静默不触发，行为与今天一致（[ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)）。
- **工作区 `...` 菜单的「管理工作区目录…」入口**：工作区行菜单与右键菜单在「重命名」与「在 Finder 中显示」之间新增一项，图标使用 workspace tree。当前会话已属于该工作区时直接打开 Workspace Folders 对话框；否则先经上游 `openWorkspace` 打开/复用该工作区的空白页，确认它成为当前会话后，再以该会话打开对话框。导航失败、被后续切换取代或目标没有成为当前会话时不弹窗；宿主通道、工作区记录、`uiWorkspace.openWorkspace` 或 footer 对话框任一缺失时该项置灰，`contextMenus` 缺席时整个入口不存在。菜单复用 footer 的现有对话框（经 `apply()` 作用域的 controller），不新增对话框实例；Files 页签的根选择器与服务端管理行为均不变。入口以 `contextMenu.icon` 槽位为门：该槽位与 `contextMenus`/`workspace` target 自 DSH `0.2.2-alpha.3` 起才存在，更早的受支持版本上本次 UI 修改完全不出现（[ADR-0038](./docs/decisions/ADR-0038-workspace-menu-folders-dialog.md)）。

### Changed

- **已批准的一次性 Full-access 提权现在按批准语义执行**：当用户在一次工具调用上批准 `sandbox_permissions: 'danger-full-access'` 的升级（上游 `approveEscalation` → `approval.request` 返回 `'allowed-once'`）后，该调用不再被插件的两条负授权否决——显式 `read-only` 附加根（含 standing mode 下只读的 `inherit` 根）与 `toolAccess` per-tool 封顶（含非法配置的 cap-everything）仅对该调用解除。`$DSH_HOME` 恰在无提权时本应被拒的同一条件下保持拒绝，Registry 权威 `unavailable` 的主根钳制照旧，standing Full-access 会话、并发/嵌套/后续调用、已运行进程、持久终端、面板终端与 OPS 派发均不受影响（[ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)）。

## [0.1.16] - 2026-11-08

### Added

- **预览页 Folder 导航树支持附加根**：上游 `0.2.2-alpha.3` 引入的文档预览 Folder 导航树原本固定以会话 cwd 为树根，预览附加根中的文件时点开 Folder 看到的仍是主根目录、也不会定位当前文件。插件现在把该导航树的树体接管到被预览文件所在的最长前缀附加根，并复刻原生 reveal 契约：逐层展开祖先、以当前行标记与 `aria-current` 高亮并把该行滚动到可见位置；树内打开文件沿用 `replaceTab` 语义；关闭再打开 Folder 时恢复展开集合与滚动位置。没有匹配的附加根（含主根文件）、跨会话地址或宿主未挂载该导航树时，原生导航树完全不受影响（[ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)）。

### Fixed

- **第三方插件的准入外受限 spawn 恢复为主根钳制启动（forge bundle）**：自 `v0.1.12` 的逐操作准入起，不经过本插件包装接缝、直接 `ctx.sandbox.confine(...)` 后 `ctx.subprocess.spawn(...)` 的第三方消费者（如实验性 forge bundle 的面板 Git 检查与 worktrees 服务）会被进程围栏当作来源不明的受限 argv 硬性拒绝。现在 scope 维护按**铸造时**发布代次键控的有界铸造台账：只有本进程铸出的主根形态 profile（`clamped` / `read-only`）在铸造发布仍然有效时可无准入启动，根表内容变化或权威可用性翻转即失效；可到达的 `worktrees` / `forgePanel` Session 入口改经真实有序准入包装，准入不可达时退回无准入执行并告警。伪造 argv、他进程 argv、被超越发布或过期准入帧遗留的 profile 继续拒绝，OPS 保护窗口仍把台账 mint 按无归属 spawn 处理。已知局限：Session 仓库位于附加根时，面板的 worktree 创建/恢复仍以主根钳制 profile 执行，附加根路径的写入会被内核拒绝；模型的 worktree 工具不受影响（[ADR-0035](./docs/decisions/ADR-0035-unadmitted-confined-spawn.md)）。
- **面板区分「会话存在但未在本实例激活」**：会话被另一个 DSH 实例持有（跨进程 writer 锁）、仍在恢复或等待格式迁移时不会进入本进程的 SessionStore，面板此前一律报 `session-not-found`（「找不到该会话」）——会话明明就在屏幕上，提示的重试动作也不适用。现在 `dispatchPanelRequest` 在失败处复跑 resolver 并探测 `sessionPersistence.stat`，只在能证明持久化快照存在时改报 `session-not-live`，并给出可操作的中英双语提示；活会话仍无法给出主根（cwd 缺失或非绝对）以及探测无法证明存在的情况保持 `session-not-found`。授权合同不变：仍然只有本进程的 live 会话能解析主根（[ADR-0008 修订](./docs/decisions/ADR-0008-panel-session-derived-authority.md#修订失败码按持久化存在性细分2026-11-07amendment)）。

## [0.1.15] - 2026-11-06

### Changed

- **自定义组合升级注意：Registry 只保留共享模式**。`multi-root-registry` 必须配置 `sharedStorageRoot`；缺失时以 `config-invalid` 拒绝启动，不再打开单进程存储或授予附加根。默认 bundle 自 `v0.1.12` 起已配置共享模式，无需另行修改。主根登记表改为按上游 Session 原始目录拼写查找，升级时迁移旧 canonical key；清空后的空表会持久保留，防止刷新或重启复活旧登记（[ADR-0028](./docs/decisions/ADR-0028-upstream-primary-identity-and-shared-only-registry.md)）。

### Added

- **`/add-dirs` 命令别名**：`/add-dirs [absolute path] [--inherit|--read-only|--read-write]` 复用 `/workspace-folders add` 的路径解析、目录选择器、访问选项和校验，不接管 dsh-TUI 的内置 `/add-dir`。
- **OPS 兼容模式（实验性，默认关闭）**：在插件设置卡中显式开启 `multi-root-ops-compatibility.enabled`，仅适用于现有精确支持矩阵内的 DSH `0.2.*`；`0.1.*` 不提供该设置入口，手工写入 `true` 也不启用。从 UI 开启须先在宿主风险弹窗中勾选并确认，每次重新开启都需确认；关闭直接保存，OPS 与 Auto Review 开关独立。
- **启用 OPS 模式后的保守执行保护与上下文**：macOS/Linux 的 Full-access 有只读或 tool-cap 拒写边界时，以内核围栏保护 Worker；Windows 有拒写边界、WW/RO 有不可写根或 cap，以及所有模式 Registry 失权时，执行调用在准备前保守拒绝，读取也可能被拒。可证明的实时成功文件目标可触发附属目录指令发现；Auto Review 仍仅支持精确 DSH `0.2.1-rc.2`，缺少历史证据、动态待审目标或快照变化时技术失败。**不声明完整 OPS 兼容**：合法操作误拒、后台清理与缓存残留、无持久活动等限制保留，完整兼容恢复无限期延后；关闭模式后 OPS 仍可能写入显式只读附加根（[能力与限制](./README.md#dsh-ops-适配现状受限能力说明)、[ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md)）。

### Fixed

- **重新登记不再把旧授权转移到新目标（BYP-02）**：只有目录恢复到原 grant 目标时才能 revive；目标已改变的记录必须先移除再显式新增。面板只为 missing 记录提供重新登记，不为 redirected/invalid 记录提供该动作。
- **附加根登记拒绝覆盖受保护目录**：新增与 revive 不得等于、包含或位于 `$DSH_HOME`、Registry 物理介质或 lease 目录；重叠存量记录 withheld 并保留拒写边界。共享 follower 在每次 fs/进程准入时同样按自己的保护集合收窄；Windows 网络/设备路径在本地解析和转发前拒绝（[ADR-0027](./docs/decisions/ADR-0027-revive-target-and-protected-paths.md)）。
- **主根目录置换不再丢失已有拒写边界（MRW-01）**：Registry/scope 使用上游主根拼写作为身份，canonical 路径只用于几何判断，拒写边界优先于主根重叠。主根本身的写授权继续遵循上游语义；根管理的可信人工确认（BYP-01）仍是已知残余风险，不在本版修复范围（[范围与维护者决定](./docs/plans/completed/2026-11-05-root-authorization-security-fixes.md)）。

## [0.1.14] - 2026-11-05

### Added

- **精确支持 DSH `0.2.2-alpha.3` 与 `0.2.2-rc.1`**：支持矩阵扩至 22 个精确版本，开发 pin 提升到 `0.2.2-rc.1`（cordis `4.1.0` / Schemastery `3.19.0`）。`alpha.3` 起上游把 `patchText` / `deleteFile` / `moveFile` 纳入同一文件系统围栏与 Registry admission（移动的源与目标共用同一准入快照）、Connection RPC getter 绑定拥有路由的消费 fiber（修复新版 Cordis 下面板通道 HTTP 405）、Files 页签改用宿主提供的文件树 Factory；`rc.1` 相对 `alpha.3` 仅有版本号与 vendor 稳定化，没有新接口形状，未新增适配分支。升级脚本的稳定 vendor 选择器改为只取宿主声明 minor 线内的最新稳定 patch，避免旧版 Cordis 混入新 loader。可选 Auto Review 仍钉 `0.2.1-rc.2` 基线（[接口审查](./docs/reference/dsh-0.2.2-migration.md)）。
- **插件详情页「多根 Auto Review」设置开关（实验性，默认关闭）**：与插件管理页同名 Loader 行等价，经 `remote.pluginManager.setPluginEnabled` 持久化并热应用，`restart-required` 时以 Toast 提示重启；宿主无 pluginManager Remote 或组合未列该可选行时该行不渲染，与附属根 Skills 共用单一 `plugins.bundle.config` 设置单元格。
- **插件管理页富文本详情**：本地化 `meta.detail`（`locale/en|zh.json` 经 `./locale/*.json` 导出）与 640×300 自包含预览图（`detail/`），遵循上游插件详情页惯例。

### Fixed

- **`profile-core-mixed` / `profile-core-copy` 启动器告警（[issue #30](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/30)）**：`schemastery` 与 `node-addon-system` 移入 `peerDependencies`——两个共享上游单例改由宿主 `dsh-sandbox-local` 供给唯一副本；此前它们作为 `dependencies` 会让包管理器在 profile 里装出第二份（`^3.18.2` 不匹配宿主 prerelease，装出 `3.18.5` 连带 `cosmokit@1.8.6`）。`compat:check` 与测试现在硬性拒绝 `dependencies` / `optionalDependencies` 里的任何 `@deepseek-ai/*`；已装旧版的 profile 需 remove + add 重建 `node_modules`（[排查](./docs/troubleshooting/profile-core-mixed.md)）。
- **darwin-arm64 上安装副本无声 SIGBUS 退出**：`koffi` 一律经 `loadHostKoffi()`（`src/compat/koffi.ts`，以必需 peer `dsh-fs-local` 为锚）解析宿主副本——profile 安装会再装一份私有 koffi，与宿主已加载的 `koffi.node` 构成同进程第二个原生镜像，在指针校验下直接 SIGBUS；解析不到宿主副本时才回退包内自带。
- **设置卡并发刷新竞态**：`plugin-manager/changed` 刷新与 `setEnabled()` 后的刷新并发时，旧响应后到会覆盖新快照、开关停留在写入前的值；新增 `refreshSeq` 代际计数，非最新请求的结果直接丢弃。
- **设置卡错误反馈改 Toast 横幅**：Auto Review 与 Skills 设置行的内联 `role=alert` 文案改为顶部 Toast 提示，状态源消失时自动撤下。

## [0.1.13] - 2026-10-31

### Added

- **共享 Registry 后台恢复（默认开启）**：多个 Host 共享登记表时，可重试的权威争用、断线或存储打开失败会以退避和抖动自动重试；follower 重新同步已跟踪主根后才视为恢复。`multi-root-registry` 的 `backgroundRecovery: false` 可关闭后台重试，按需恢复仍可用；配置错误和状态不明的写入仍需修正配置或重启。恢复期间继续保留拒绝边界，每个新操作仍须授权，结果不明的变更不会自动重放。只读诊断信息和去重的状态转换日志有助于排查故障（[ADR-0026](./docs/decisions/ADR-0026-registry-background-recovery.md)）。

### Fixed

- **Files 页签打开文件后保留所选根**：打开附加根中的文件导致 Files 页签卸载并重新挂载时，保留该页签所选的根、目录展开状态与滚动位置；列表尚未应答或请求失败不会误将选择切回主根，关闭页签时会清理监听与目录树资源。
- **共享权威恢复的安全性和一致性**：介质与锁绑定校验失败后重试不能绕过校验；恢复时同步根投影并批量发布一致的状态，空快照能清除过期边界，失败的恢复轮次不再产生重复通知。Windows 连接握手期间保持请求计时器有效，避免进程提前退出。

## [0.1.12] - 2026-10-30

### Added

- **多个 Host 可同时使用附加根（默认开启）**：bundle 现默认配置共享存储权威（`sharedStorageRoot`）——此前只有持有 store 租约的 Host 能使用附加根，共享同一登记的第二个 Host 一律 fail-closed。现在唯一 owner 打开存储介质并管理持久化，其余 Host 经本机内核认证的 IPC 通过各自的 Registry facade 读写；所有变更与每个新操作的授权在 owner 处统一排序：撤权后的新操作立即被拒，撤权前已准入的操作可以完成，断线/失联时保留既有拒绝边界；owner 退出或崩溃时 follower 竞选接管并以新 epoch 恢复，丢失的已提交应答不会自动重放。已复制的执行参数与过期句柄不能顶替新准入，同步 confine/spawn 入口保持原有返回形状；fs、sandbox、shell/PTC/agent PTY、LSP、Files/watch、指令与 Skills 消费路径全部接入准入。未启用 `sharedStorageRoot` 的 profile 保留旧的「争用即 fail-closed」行为（[ADR-0024](./docs/decisions/ADR-0024-registry-operation-admission.md)、[ADR-0025](./docs/decisions/ADR-0025-shared-registry-authority.md)、[共享服务架构](./docs/architecture/registry-authority-service.md)）。
- **精确支持 DSH `0.2.1-rc.5`**：相对 `0.2.1-rc.4` 没有触及本插件的接口变化，不新增适配分支；开发 pin 保持 `0.2.2-alpha.2`，支持矩阵现为 20 个精确版本。

### Changed

- **依赖安全下限提升**：本插件直接依赖的 `zod` 下限升至 `^4.6.7`；开发侧 `vitest` 升至 `^4.1.12`，并显式声明 `@modelcontextprotocol/sdk` `^1.32.2` 以保留 GenAI `mcpToTool` 的可选能力。完整开发树的公告告警从 1 critical / 17 high / 27 moderate 降为 5 high / 6 moderate；宿主树中剩余告警均由 DSH 精确 pin 引入（如 zod `4.4.3`、Undici `8.11.2`），不随本插件版本解决（[依赖安全排查](./docs/troubleshooting/dependency-security-alerts.md)）。

## [0.1.11] - 2026-10-29

### Added

- **精确支持 DSH `0.2.1-rc.4` 与 `0.2.2-alpha.2`**：`rc.4` 探针全绿、无需任何适配改动；`0.2.2-alpha.2` 把工具执行从 `dsh-tools` 拆出为独立执行器，`AgentRegistry` 新增注入 `sessionProjections`，本插件源码均不受影响。上游新增 `SandboxExecutionPolicy.additionalWritableRoots`（原生与 fork 无关的第三路可写根），宽授权 provider 与其正确复合——新回归用例钉住双方 grant 同时生效。开发 pin 提升到 `0.2.2-alpha.2`（cordis `4.0.6-alpha.1`，Node ≥24.9）。客户端 fork（files-tree、open-in-app）已对齐 `0.2.2-alpha.2` 基线——hover 规则移入 `@media (hover: hover)`，open-in-app 失败反馈改为应用级 `shell.overlay` outcome toast。
- **升级通道与 CI**：CI verify 矩阵改为按已知名单分流——`0.1.*` / `0.2.0` / `0.2.1` 走 Node `22.19.0`，其余（含 0.2.2 及以后）走 Node `24.9.0`；升级脚本在重指旧版本时会顺带钉住该版本自带的 cordis 生态（plugin-loader/group/include、schemastery、cosmokit），避免与提交锁文件的 alpha 行混树。

### Fixed

- **Registry Authority 重复通知引发的 Skills 刷新反馈循环（[Issue #24](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/24)）**：第二个 DSH 进程争用登记表 lease（或存储打开失败）时，附加根 Skills 的每次查询都经 `refresh()` 重试 lease；失败后 `setRegistryAuthority(false)` 即使状态没有变化也通知监听者，使 Skills 缓存失效并广播 `skills/change`，收到事件的客户端立即重查，形成无界反馈循环——等待方 Host 空闲时持续占用约一个 CPU 核心、内存增长直至 V8 OOM，零附加根同样可触发。现在仅在实际状态变化时通知；lease 重试、持锁方退出后的接管、以及「权限不可用时仅主根可写」的 fail-closed 语义不变（[故障排查](./docs/troubleshooting/registry-owned-by-another-process.md#skills-查询导致持续刷新issue-24)、[ADR-0023 修订](./docs/decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md#4-生命周期缓存与撤销)）。

## [0.1.10] - 2026-10-25

### Added

- **附属根 Skills**：发现附属目录的 `.dsh/skills` 和 `.agents/skills`，首个模型步骤可见名称与描述，正文按需加载。主根使用 `/skill-name`；附属根始终使用 `/alias-id:skill-name` 命名空间引用（Slash 菜单可补全，模型经原生 `skill` 工具用内部名称调用）。新登记的 `inherit` / `read-write` 根默认开启，`read-only` 根默认关闭；Workspace Folders 对话框提供独立的 Skills 开关与 `aliasId` 编辑，Settings → Plugins → Multi-root Workspace 的「启用附属根 Skills」全局开关默认开启，关闭只阻止新发现与调用、保留每根选择。升级时旧 `inherit` / `read-write` 登记默认开启 Skills；持久化迁移保留原有 grant，但旧版写回可能剥离 `aliasId` 与手动开关，**不保证 Skills 配置无损降级**（降级前可备份 `$DSH_HOME/storages/multi_root_workspace.json`）。只读根开启 Skills 不授予写权限；禁用不回收已投递正文或已启动进程（[ADR-0023](./docs/decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md)）。
- **精确支持 DSH `0.2.1-rc.3`**。上游 `rc.2`→`rc.3` 的差异全部为新增（新 sidebar 槽位、导航 pins、DeepSeek `/models` 列表），不需要新增适配分支；开发 pin 提升到 `0.2.1-rc.3`（cordis `4.0.5` 不变）。

### Fixed

- **Workspace Folders 面板与上游 UI 对齐**：设置开关行布局、Skills 开关收入图标动作区、按钮背景只出现在 hover、保存期间动作外观保持、根策略与生效访问合并为一个标签；移除上移/下移排序按钮（排序接口保留，供后续拖动排序）与对话框顶部的权限说明文字。
- **命名空间 Skill 引用的展示**：已发送的 `/alias-id:skill-name` 引用按普通用户文字渲染，不再携带独立按钮样式、高亮或点击预览（ADR-0023 同日修订）；普通会话的 activity/title 更新不再误关闭已打开的 Skill 正文预览。

## [0.1.9] - 2026-10-20

### Added

- **可选 Auto Review（默认关闭）**：主包新增 `./auto-review` 子路径导出与 `multi-root-auto-review` patch 行——fork 上游实验性「自动授权审查」，向 Reviewer 补充附加根的审查上下文：当前工作区拓扑、各根有效访问级别与实时指令文件。该行出厂 `disabled: true`，关闭时不挂载 reviewer 或 review context、不注册 Auto preset；普通支持矩阵不变，仅 DSH `0.2.1-rc.2` 可启用——在任何其他版本上打开会响亮失败，不会静默降级。启用方式：在插件管理器的行列表中打开 `@dsh-electron/dsh-plugin-multi-root-workspace/auto-review` 行（无热重载的 profile 按提示重启），或在 profile 的 `cordis.patch.yml` 中置 `disabled: false`；context 与 reviewer 共用这一个开关。
- **启用后接管官方 reviewer**：同一个开关挂载多根 review context 与 fork reviewer，并在运行时停止同组官方 `@deepseek-ai/dsh-experimental-auto-review` 行——官方 bundle 位于主包前后均可，接管只改运行时状态、不写回官方的持久配置；官方 bundle 未被选择时该行独立运行（自带注册 Auto preset）。关闭后官方按原配置随 reload/restart 恢复，不自动重选 Auto；任何存活 Auto owner 的卸载沿用官方 Auto → Full access 语义。曾以本地 tarball/link 安装过旧独立 companion 包的 profile，须先移除其 bundle 与依赖再启用本行（残留 companion 与内置入口共存会被明确拒绝）。使用说明见 [src/auto-review/README.md](./src/auto-review/README.md)（[ADR-0021](./docs/decisions/ADR-0021-auto-review-context-companion.md)、[ADR-0022](./docs/decisions/ADR-0022-auto-review-loader-entry.md)）。

## [0.1.8] - 2026-10-18

### Fixed

- **DSH 0.2.0 上权限设置页不可用**：以 `link:` 方式安装时，插件把只作为宿主服务消费、自身从不加载的可选包（`dsh-lsp` / `dsh-lsp-stdio` / `dsh-working-directory` 等）解析到检出目录自己的 devDependencies，版本统一的宿主被误判为 `mixed`；同时两个 provider 替身行 inject 兼容门禁而上游 `fs-sandbox` / `sandbox` 已被无条件禁用，门禁一旦拒绝，`ctx.fs` / `ctx.sandbox` 消失并连带 `ctx.shell` 与 `permissionPresets` 瘫痪（`permissionPresets/catalog` 报 `service-unavailable`）。可选包现按"谁加载副本、经哪个锚点"分为运行时加载、宿主服务与 runner 锚定三类——插件根内的宿主服务副本不再作证，Windows ACL 包改从 `dsh-sandbox-local` 锚点取证；两个 provider 行不再 inject 门禁，在被拒安装上退化为上游等价行为，宽授权行的门禁不变（[ADR-0009 修订](./docs/decisions/ADR-0009-dsh-compat-contract.md#修订2026-10-18permissionpresetscatalog-事故误报检测--被门禁的-provider)）。

## [0.1.7] - 2026-10-17

### Added

- **Files 页签内浏览附加根**：文件树 header 新增根切换器（伪装成路径标签的菜单入口，列出主根与全部附加根及其状态）；选中附加根时由逐字节复刻的上游 Files 树接管树区——行高、图标、缩进、空态与原生逐项一致，原生 reload 由 header 原位同款图标钮顶替，切回主根即完整还原。原生 open-in-app 按钮由复刻件顶替并把目标换成选中根（[ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)）。面板行带访问级别徽标，所有路径用同一 `PathCopy` 控件一点即复制；只读 → 读写升级经确认层；添加行的权限选择器为锚定下拉。
- **附加根访问级别升级为三态**：`add [--inherit|--read-only|--read-write]`（或面板添加行选择）。`inherit` 跟随会话模式——新登记的默认值，旧版插件登记的可写记录也迁移为 `inherit`；`read-only` 可读、可浏览、参与 LSP 与指令注入，但任何模式（包括 `danger-full-access`）都不授予写权限；`read-write` 固定在全局只读会话里仍可写。`/workspace-folders access <ref> inherit|read-only|read-write` 与面板按根切换（扩权要求该根此刻可用且不重新授权路径）。持久化布局向下兼容：旧版本插件把只读记录判为无效而非升级为可写（[ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)、[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- **Full-access 也强制执行拒写边界**：shell / pwsh 执行器、`run_code`（PTC）与 agent PTY 在 `danger-full-access` 下绕过 `confine`，进程围栏为它们统一套用受限内核 profile（macOS Seatbelt、Linux bwrap——上游选定 Landlock 的主机同样改走 bubblewrap，bwrap 不可用时该组合在启动前拒绝），显式只读根与被工具封顶的根在该模式下依旧拒写；fs fence 读取同一份 deny 集（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- **受限 Full-access 保护 `$DSH_HOME`**：只要存在任何拒写边界（只读根、工具封顶成员或注册表权限不可用），home 目录就进入 deny 集——存根存储、注册表 lease 与用户 profile 都在其中；零附加根且注册表健康时 Full-access 与上游逐字节一致（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- **面板用户终端不受约束**：进程围栏只对 env 带 `DSH_PTY_SESSION_ID` 的 spawn 生效（agent PTY 由 terminal-bash backend 盖章）；你在面板打开的终端属于用户行为，任何模式直通（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- **Windows 上 Full-access 的局部拒写**：随包提供需管理员安装的每用户特权 broker——安装器只向专用虚拟服务账户 `NT SERVICE\DshMultiRootBroker-<安装哈希>` 授予固定 LSA 权限（`SeServiceLogonRight`、`SeCreateTokenPrivilege`、`SeAssignPrimaryTokenPrivilege`、`SeTcbPrivilege`、`SeDebugPrivilege`、`SeImpersonatePrivilege`），不为宿主用户提权；broker 为受限子进程构造普通 deny-only 组 token，runner 读回验证后才放行。未安装 broker 时该组合拒绝启动；Windows 执行仍如实报告 partial 边界（[ADR-0020](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)）。
- **per-tool 写权限封顶**：`multi-root-scope` 行配置 `toolAccess: { <工具名>: 'read-only' }` 后，该工具永远不能写任何附加根（主根不受影响）；封顶经 `tools/execute` 的真实 dispatch 上下文执行，非法配置 fail closed（[ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)）。
- **附加根数量上限**：每个主根默认最多登记 16 条附加根记录（`maxAdditionalRoots` 可调至 64）；超限的新增被拒绝，历史超限记录照常授予。列表如实显示 `N of LIMIT`（[ADR-0014](./docs/decisions/ADR-0014-root-limit-and-provider-conflict.md)）。
- **Provider 冲突检测**：另一插件也替换 `ctx.fs` / `ctx.sandbox` 时，多根行响亮失败并拒绝一切授予，而不是依赖装载顺序（[ADR-0014](./docs/decisions/ADR-0014-root-limit-and-provider-conflict.md)）。
- **精确支持 DSH `0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1` 与 `0.2.1-rc.2`**。上游 `alpha.3` 起 `dsh-storage-domain` 把 `zod` 固定为 `4.4.3`，两个 zod 副本的类型互不兼容，域 schema 改由存储域自身解析的 zod 构建；`alpha.4` 起上游版本需求优先读 `engines.dsh`，本插件仍以 `peerDependencies` 为唯一版本契约。开发 pin 提升到 `0.2.1-rc.2`（cordis `4.0.5`；`alpha.3`–`alpha.5` 的 cordis 为 `4.0.5-alpha.2`）。

### Changed

- **模型侧拓扑文案重写**：按当前模式与平台如实陈述授权——可写与只读根分组列出，声明 cwd/worktree 切换不改变授权、授权变化只约束后续操作与新进程；配置封顶工具时点名；Windows 附带 restricted-token partial-enforcement 与读不受其 confine 的说明（[ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)）。

### Fixed

- **注册表权限不可用不再读作「没有限制」**：读到空根表的进程（争用、存储故障、配置非法）曾在 Full-access 下放行一切写；现在 `danger-full-access` 与 `workspace-write` 都只授予主根写权限（共享平台临时区不再可写），显式拒写边界仍优先，接管 lease 后恢复（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- **改名祖先目录不能再解除只读边界**：此前把被拒根的父目录改名即可把整棵树搬出路径拒写边界；现在 Seatbelt 同时拒写被拒根的每个祖先目录本身（`(literal …)`），bwrap 把祖先自绑为挂接点使 rename 返回 EBUSY；Windows 用不共享删除的目录句柄钉住根及祖先，直到受限 Job 后代排空，防止 shell 搬走目录后经宿主文件工具绕过。祖先目录的元数据或改名操作会受相应机制限制（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)、[ADR-0020](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)）。
- **负授权不随排序、消失或冲突丢失**：存量重叠登记双方撤销成员授权，但可信记录的拒写边界仍保留；新增根也检查 missing / redirected 根的保留边界。全局只读会话追加固定读写根后统一应用 deny，无法表达子树减法的后端在启动前拒绝。
- **Windows 拒写前检查全部根的硬链接**：任一根存在多链接文件或不可检查节点时，在任何 ACL 写入前拒绝启动，避免改写 pnpm store 或其他链接的共享对象。新增宿主维护命令 `/workspace-folders isolate-profiles [--apply]`：默认只读检查，显式 apply 仅将 profile 导入配置设为 copy；存量依赖仍需按报告重装，不修复历史 ACL（[ADR-0020](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)）。
- **Linux 上消失的拒写根失败关闭而非放行**：deny 根的 bwrap 挂载恢复为强制项——目录在登记后或 profile 构造后被删除时命名空间搭建失败、命令不会执行，不再出现在可写父挂载下被重建写入的缺口（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- **附加根重新登记保留原权限**：命令与面板在未显式选择访问级别时不发送默认值，避免 revive 把只读登记静默升级；达到根上限时仍可从面板重新登记既有的不可用项。
- **面板兼容旧宿主的根列表**：旧响应缺少 `limit` / `count` 时仍可显示和操作，显式非法值仍拒绝。
- **非法 toolAccess 的拓扑文案与执行一致**：模型明确看到所有附加根写被拒，不再被告知 read-write 登记可写；根上限配置 `null` 同样 fail closed。
- **安装副本在 Windows（DSH 0.1.7-alpha.1+）上的受限命令恢复可用**：发布的 v0.1.6 从 npm/tarball 安装后，独立 Windows runner 在首行之前就死于 `ERR_MODULE_NOT_FOUND`——它的静态模块图 import 的上游包无法从插件安装目录解析，受影响版本上配置了附加根的会话里每条受限命令都会失败。runner 的静态图现在只含 `node:` 内置，上游 ACL 包改为从上游 runner 自身位置按包自引用加载。
- **Windows 上的网络与设备根被拒绝**：UNC（`\\server\share`）、`\\?\`、`\\.\` 与映射网络盘此前会被当成普通附加根登记；现在在任何文件系统触碰之前以 `unsupported-path` 词法拒绝，存量记录标记为 `invalid`，受限执行侧 fail closed（`SandboxUnavailableError` / 退出 127），绝不静默放开（[ADR-0011 修订](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- **Windows runner 在 spawn 前重新验证根**：授权 ACL 之后、启动子进程之前重新确认每个根仍存在且是同一 canonical 目录，并要求 `--temp` 已存在；不满足即退出 127，不启动无约束进程。
- **Windows 上「在文件管理器中显示」不再误报失败**：`explorer.exe` 成功时也返回 1，win32 现在接受退出码 0/1。
- **面板文件端点拒绝反斜杠路径**：POSIX 上 `..\..\x` 此前会解析到所选根内部；现在词法拒绝。
- **Windows broker 放行 UAC 过滤调用方并诊断打包子进程**：非提权 UAC 管理员发起的受限命令此前被 broker 以「unrestricted 身份」拒绝；现在只拒绝携带 restricting SID 或 AppContainer 的调用方，Store/MSIX 版子进程（如 WindowsApps 别名的 `pwsh.exe`）在启动前给出指向 MSI/ZIP 版的诊断。升级后需用 `install.ps1` 重装一次 broker 才会生效（[ADR-0020 修订](./docs/decisions/ADR-0020-windows-normal-deny-groups.md)）。
- **面板文件树调用可中止**：组件卸载、路径或会话变化时取消在飞的 `files` / `readFile` 调用，过期响应不再渲染为错误。

### Changed

- **Windows 受限 shell 行为说明**：受限 shell 是 pwsh（Git Bash/MSYS 在 restricted token 下无法启动，与上游 runner 一致）；在插件 runner 下 confined 子进程能收到 Ctrl+C 且 runner 镜像其退出码，而上游 runner 的子进程因继承 ignore-Ctrl+C 标志收不到（两者均为既成事实，见 [ADR-0011 修订](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- 安装提示补充：被 `koffi` 构建授权打断的首次安装，在授权后若插件未进 `dsh.profile.bundles`，需一次 `remove` + `add` 完成激活（[故障排查](./docs/troubleshooting/install-stops-at-build-approval.md)）。

## [0.1.6] - 2026-10-11

### Added

- 精确支持 DSH `0.2.1-alpha.1` 与 `0.2.1-alpha.2`。动态 working directory 与 Session origin 分离：cwd 切换不改变注册表归属或授权根；新增 Worktree 管理、附加根 LSP 路由、Windows 内核级多根，以及 Workspace Folders 附加根文件浏览与预览。
- 附加根说明文件的 cwd 切换恢复与补发行为，避免上游撤回后遗漏仍有效的说明。

### Changed

- 附加根文件树与 LSP 按根隔离；Worktree 操作不改变根注册表授权。

## [0.1.5] - 2026-09-30

### Added

- 精确支持 DSH `0.2.0-rc.1` 与 `0.2.0-rc.2`，保留此前全部支持版本。CI 会在所有启用的操作系统上验证兼容合同中的每个版本。

## [0.1.4] - 2026-09-25

在 `v0.1.3` 的精确 allowlist 契约不变的前提下，把受支持的上游运行时扩展到 `0.1.7-rc.2`；设计取舍仍见 [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)。

### Added

- **支持上游运行时 `0.1.7-rc.2`**。相对 `0.1.7-rc.1`，`confine`、指令渲染、session format 4、工具失败位、面板图标、当前会话目录、进程内启动和 bash 执行的形状都没变，适配层没有新分支。cordis 仍是 `~4.0.4`。`rc.1` 起的安装期 peer 门禁仍然要求这个精确版本出现在 `peerDependencies` 里。开发 pin 仍是 `0.1.5-rc.2`。

## [0.1.3] - 2026-09-24

在 `v0.1.2` 的精确 allowlist 契约不变的前提下，把受支持的上游运行时扩展到 `0.1.7-alpha.2` 与 `0.1.7-rc.1`；设计取舍仍见 [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)。

### Added

- **支持上游运行时 `0.1.7-alpha.2` 与 `0.1.7-rc.1`**。相对 `0.1.7-alpha.1`，`confine`、指令渲染、session format 4、工具失败位、面板图标、当前会话目录、进程内启动和 bash 执行的形状都没变，适配层没有新分支。`0.1.7-rc.1` 起，`dsh plugin add` 会按 `peerDependencies` 拒绝不满足当前运行时的插件，所以这两项必须出现在精确 allowlist 里。开发 pin 仍是 `0.1.5-rc.2`。

## [0.1.2] - 2026-09-22

在 `v0.1.1` 的精确 allowlist 契约不变的前提下，把受支持的上游运行时扩展到 `0.1.6-alpha.2` 与 `0.1.7-alpha.1`；设计取舍仍见 [ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)。

### Added

- **支持上游运行时 `0.1.6-alpha.2`**，与 `0.1.5-rc.2`、`0.1.6-alpha.1` 一起进 allowlist。该版本的 `confine` 异步形状与 instruction renderer 名字与 `0.1.6-alpha.1` 相同；客户端当前会话改从目录行的 `retainedBy.mainView` 读取（见 Fixed）。开发 pin 仍是 `0.1.5-rc.2`。
- **支持上游运行时 `0.1.7-alpha.1`**。`confine` 与 instruction renderer 的形状没变，但这一版有几处必须适配：session format 4 不再接受 `kind: 'plugin'`，附加根指令改用本插件自己的 source kind `multi-root-workspace`（format 3 及更早仍是 `plugin`）；工具失败位从 content block 移到消息本身；面板图标从像素命名改为 Regular 线宽；进程内启动改为 `createRuntimeResolution` + `PluginPackages`；bash 执行从 `shell.run` 改为 `shell.execute().result()`。该版本的 `dsh` 依赖 cordis `^4.0.3`，探测时必须把 cordis 钉到这个版本，否则两份 `@deepseek-ai/dsh-tools` 会让工具调度用的 Symbol 对不上、工具调用在第一步失败。开发 pin 仍是 `0.1.5-rc.2`。

### Fixed

- **`0.1.6-alpha.2` 上已打开的会话被面板显示成「当前没有活动会话」**：该版本从 Session 目录快照删除了 `current`，当前会话改由主视图 `retain(..., { source: 'mainView' })` 持有，投影在目录行的 `retainedBy.mainView`。`src/compat/client-session.ts` 用结构探测同时认两种形状；目录有行但没有主视图时仍显示空态，不会把 `ids[0]` 当成当前会话。

## [0.1.1] - 2026-09-16

`v0.1.0` 之后的**硬化批次（H1–H4）**：不新增面向使用者的"功能"，而是补齐跨进程、面板权威、上游兼容性与附加根指令四类边界。设计取舍见 [ADR-0007](./docs/decisions/ADR-0007-registry-authority-lease.md)、[ADR-0008](./docs/decisions/ADR-0008-panel-session-derived-authority.md)、[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)、[ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)。

### 升级注意（不兼容变更）

- **首次 `dsh plugin add` 会失败一次，四种安装来源皆然**：本版本新引入原生依赖 `koffi`（Windows 上 Registry Authority 的 FFI 封装），而 pnpm ≥10 默认不运行依赖的构建脚本，因此第一次 `add` 会以 `[ERR_PNPM_IGNORED_BUILDS]` 退出、插件不会进 `dsh.profile.bundles`。`dsh` 会把待决项留在该 profile 的 `pnpm-workspace.yaml` 里（`koffi: set this to true or false`），改成 `true` 再执行一次 `add` 即完成。`v0.1.0` 的 npm / tarball 来源没有这一步。详见[故障排查：安装停在构建授权](./docs/troubleshooting/install-stops-at-build-approval.md)。
- **支持的上游运行时收窄为精确清单 `0.1.5-rc.2`、`0.1.6-alpha.1`**（原先是 `>=0.1.2-alpha.4 <0.2.0` 范围）。宿主版本不在这两个之一，或若干 `@deepseek-ai/dsh-*` 包混装了不同版本时，`fs` / `sandbox` / `registry` / `instructions` 四行**不启动**，组合退化为"未装这个插件"并在启动时打印说明。理由是这个插件替换的是围栏本身、靠识别上游实测出的方言 argv 形状工作，而 npm 语义化范围等于对未验证版本做承诺（[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。诊断步骤见[故障排查：DSH 版本不在支持矩阵上](./docs/troubleshooting/unsupported-dsh-release.md)。**若你仍在 `v0.1.0` 时代实测可用的 `0.1.2-rc.1` 运行时上（例如某些已安装的桌面端自带运行时），请先升级该运行时，否则本版本不会生效。**
- **面板不再接受客户端指名的根**：所有面板端点必填 `sessionId`，主根只来自 host 侧的 `session.header.cwd`；客户端 `primaryRoot` 字段与 `sandboxPolicy` 回退已删除。浏览器当前没有活动会话时，面板显示"当前没有活动会话"并且不向 host 发请求（[ADR-0008](./docs/decisions/ADR-0008-panel-session-derived-authority.md)）。

### Added

- **跨进程 Registry Authority（H1）**：同一 `$DSH_HOME` 上同时只允许一个 DSH 进程持有根登记表（POSIX `flock` / Windows named semaphore，进程退出或崩溃由内核释放锁）。争用方 fail-closed——发布空 scope、注册表写操作报 `registry-contended`；持锁者退出后，`/workspace-folders list` 或面板刷新即经 `refresh()` 接管（[ADR-0007](./docs/decisions/ADR-0007-registry-authority-lease.md)）。
- **附加根自身的指令文件进入模型上下文（H4）**：附加根**顶层**的 `AGENTS.md` / `CLAUDE.md` 在会话第一步之前注入；本会话**成功** `read` / `write` / `edit` 触碰过的子目录（含被触碰文件的每个祖先目录，直到该附加根）在其目录被考察到时增量补投；文件内容变化只重发该文件，文件或根消失时**显式撤回**。全部附加根共享 64 KiB 预算，以 `user` role 的 `{ kind: 'plugin', form: 'instructions' }` 消息投递（不是 `systemPrompt`）。上游的指令发现从会话 cwd 向上走，永远到不了附加根，这是本项存在的原因（[ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)）。
- **支持第二个上游运行时 `0.1.6-alpha.1`**，与基线 `0.1.5-rc.2` 一起进 allowlist；两者都跑过完整矩阵（`confine` 的同步/异步形状差异、instruction renderer 改名、两种 LLM wire 协议均由适配层与 smoke 吸收）。
- **`pnpm compat:check`**：allowlist / `peerDependencies` / 开发 pin / 已安装树四者一致性门禁，是 CI 的第一步。
- **`multi-root-compat` 启动门禁行**：版本判定变成其余安全相关行的前置条件，而不是一条日志。
- **按周升级车道**（`upgrade.yml`）：自动重指最新上游 pre-release 并跑完整矩阵，只读权限、不提交、不自动扩大 allowlist。
- 两个故障排查条目：[DSH 版本不在支持矩阵上](./docs/troubleshooting/unsupported-dsh-release.md)、[根登记表被另一个进程持有](./docs/troubleshooting/registry-owned-by-another-process.md)。

### Changed

- 上游版本差异集中在 `src/compat/` 适配层，一律按**结构探测**（返回值是否 thenable、导出的是哪个名字）判断，不比较版本字符串；业务代码不再出现任何版本判断。
- 两个可选 peer（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-agent-instructions`）改为**按需加载**：barrel 的加载期依赖集合等于必需包集合，一个从不需要构造消息的最小组合不会在加载时失败。
- `pnpm verify:all` 有意**不含** `compat:check`（升级车道要在一个还不在 allowlist 上的候选版本上跑完整矩阵）；CI 主车道单独把它排在最前。
- 新增 `./compat` 与 `./instructions` 子路径导出。
- 安装与发版：`prepare` 脚本改为自包含（git 安装由 pnpm 现场构建，用户需先授权 `allowBuilds`）；README 补齐 npm / tarball / 本地路径 / GitHub 四种安装来源；npm 发布改用 **trusted publishing（OIDC）**，仓库不再保存任何 npm 凭证。

### Fixed

- **注册表拆除顺序**：原先"先释放内核 lease 再关闭 domain"，继任进程可能拿到 lease 后打开一份缺了本进程最后一次写入的快照；现在整个拆除在 store-wide authority 转场队列内按"排空在飞 mutation → 关闭 domain → 释放 lease"执行，并置 `disposed` 拒绝后续 acquisition（`tests/registry-lease.spec.ts`）。
- **指令投递状态按实际产物提交**：renderer 省略或截断文件时不再记录完整 digest；消息构造失败或被取消不再把指令当成已送达；预算耗尽后仍检查撤回，跨根撤回与延迟触碰不再被跳过。
- **附加根中间目录的指令文件**此前永远到不了模型（只考察被触碰文件的父目录），现在其每个祖先目录都会被考察。
- **`DSH_MULTI_ROOT_COMPAT=warn` 收紧**：只放宽 `unsupported`（版本一致、allowlist 未列名——升级车道要探测的正是这一种），`mixed` / `incomplete` 在两种模式下都拒绝。
- **"包不存在"与"已安装但求值失败"分离**：后者不再被当成缺失缓存，进程不会静默停止投递附加根指令。
- **Windows 锁命名按物理路径归一化**：经路径别名（junction / 符号链接）访问同一 store 的两个进程此前会各持一把锁，可同时成为 authority。
- **会话事件配对按会话分隔**：不同会话使用相同 `tool/call` id 时不再互相覆盖、把目录记到另一个会话。
- **升级工作流的 shell 输入处理**：手动版本与候选版本经 step `env` 传值并校验为单行，不再拼进 `run` 源码。
- **本地打包不再夹带历史构建产物**：`lib/` 在 `bundle` 之前先清掉上一轮的 JS 面（tsdown 的共享 chunk 按内容哈希命名，旧名字不会自己消失）。`pnpm pack` 出的 tarball 现在只含一轮构建的制品，不再把历史 chunk 当死代码发出去（`files` 里的 `lib/*.js` 会全部进包）。

## [0.1.0] - 2026-09-13

首个发布版本：MVP 的三个里程碑（M1–M3）。

### Added

- **插件骨架与组合方式（M1）**：以 bundle patch 替换上游 `fs-sandbox` 与 `sandbox` 两行 provider 并插入本插件的行（`bash-sandbox` 保持上游——bash 与 PTY 的 confinement 全部经 `ctx.sandbox`）。未配置附加根时行为与未装插件逐项一致；组合、disable/insert 时序与 provide 冲突三类结构性风险由差分测试钉住。
- **多根能力（M2）**：`ctx.multiRootScope`（唯一授权源）、`MultiRootFileSystem`（进程内 containment fence，子类自上游 `LocalFileSystem`，`LocalFileSystem` 自身没有 fence）、`MultiRootSandboxProvider`（在 Seatbelt / bwrap / Landlock 三种方言的 profile 上克隆上游 grant 拼法追加附加根）；fs 与 bash/PTY 共享同一条 scope，安全不降级。
- **模型可见的拓扑快照**：仅 `workspace-write` + 非空附加根时经 `systemPrompt.context` 输出（同 workspace、cwd 不变）；空根与只读模式逐字节不变。
- **根注册表（M3）**：以 canonical 主根为键持久化在 `multi_root_workspace` storage domain，写入与读取都做校验；每条记录带 `recordedPath`，**重新解析路径不等于重新授权**——目录被替换成指向别处的符号链接时该根标为 `redirected` 并暂不授予。
- **`/workspace-folders` 命令**：`list` / `add <路径>`（无参数时打开系统目录选择器）/ `alias` / `remove` / `reveal`，headless 下同样可用。
- **Workspace Folders 浏览器面板**：侧栏底部动作 + 自绘对话框，经插件自己的 Connection RPC 通道与 host 通信；文案中英双语跟随界面语言，配色全部使用 host 的 `var(--dsw-*)` 设计 token。
- **跨仓库旅程 e2e**（`pnpm smoke:journey`）：在 `web` 与 `headless` 两种组合下各驱动一轮真实 agent 回合，跨两个 Git 仓库（主根 `repo-a`、附加根 `repo-b`）并断言根外写入被拒。无需模型凭据（脚本化模型端点）。
- **安装形态**：npm 注册表 / tarball / 本地路径 / GitHub；tag 触发的 `release.yml` 完成 verify → npm publish（provenance）→ GitHub Release。
- **平台范围**：macOS（Seatbelt）与 Linux（bwrap / Landlock）的内核级多根全量；Windows 覆盖 `fs` 写路径，受限 bash/PTY 的多根不在本期（非空 scope 时输出一次显式告警）。

### Fixed

- 发布前外部评审提出的 8 项发现（其中 3 项发布阻断）全部修复，每项各带一个回归测试：登记目录被替换为符号链接后授权转移（引入 `recordedPath`，**重新解析路径不等于重新授权**）、并发修改注册表丢写或复活已撤销的授权（每个主根的变更串行）、刷新不重新检查目录、手输路径被目录选择器覆盖、`reveal` 的应答契约与失败码、重复 id 未校验、主根未纳入嵌套校验、CI 先测后构建。

[Unreleased]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.24-beta.2...HEAD
[0.1.24-beta.2]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.24-beta.1...v0.1.24-beta.2
[0.1.24-beta.1]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.23...v0.1.24-beta.1
[0.1.23]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.22...v0.1.23
[0.1.22]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.21...v0.1.22
[0.1.21]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.20...v0.1.21
[0.1.20]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/tag/v0.1.0
