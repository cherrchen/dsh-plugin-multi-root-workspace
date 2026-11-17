<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

中文 | [English](./README.en.md)

</div>

## 项目简介

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 默认把新建工作区所在的目录作为 Agent 的主目录，在默认的工作区读写模式（`workspace-write`）下，沙箱的读写范围也仅覆盖这一个目录。本插件将 DSH 的工作区范围拓展到“一个主目录 + 多个附加目录”。

并非所有项目都是 monorepo。一个开发项目往往由多个独立 Git 仓库组成，跨仓库干活原本得反复换会话。同类工具早已支持在一个工作区添加多个文件夹，本插件把同样的能力带给 DSH：把其他仓库登记为附加根，并按需设为只读、读写或跟随会话当前的权限，Agent 即可在授权范围内读写。

- **沿用原生工具**：在本地工作区，Agent 照旧使用原生 `read` / `write` / `edit` / `bash`，只是多了几个可访问的目录。
- **权限真正生效**：每个附加根可以设为只读、读写，或跟随当前会话的权限；限制由系统沙箱实际执行，而不是靠提示词提醒模型。Agent 的文件操作和 bash 命令适用同一套授权；由其他插件自行启动的进程不在这一保证内。
- **在 Files 页签里浏览附加根**：Files 页签顶部可以在主根和任一附加根之间切换；附加根的目录树、打开文件、在外部应用打开、右键菜单、自动刷新和搜索都与主根一致，文件预览页的目录导航也会定位到文件所在的根。宿主版本较旧时，这些界面操作可能不可用，附加根仍按宿主原本的方式显示。
- **附加根的 Skills**：自动发现附加根中的 `.dsh/skills` 和 `.agents/skills`，可用 `/别名:技能名` 调用；每个根可单独开关，默认开启。
- **Auto Review（实验性，默认关闭）**：在插件管理器中手动开启后，自动审查也会看到附加根的目录结构、访问级别和指令文件，把附加根一并纳入审查。
- **Worktree 建议（实验性，默认关闭）**：主根是 Git worktree 时，插件会提示把同一仓库的其他 worktree 添加为附加根；只有你确认后才会登记，不会自动增删。
- **SSH 远端环境（实验性，默认关闭，未发布）**：插件详情卡的"SSH 远端环境"开关（实验性警示标签，开启需风险确认）按部署清单打开 Registry 远端控制面；配合部署方提供的 broker 凭据隔离证明后，Agent 获得 `remote_copy` / `remote_bash`；Workspace Folders 面板显示远端工作区列表并提供独立的 SSH 远端管理对话框，每次调用仍经 Registry 准入。开关关闭时无任何模型可见的远端能力。
- **不登记等于没装**：没有附加根时，行为和未安装插件完全一致；配置有误会直接报错，不会悄悄降级。

当前发布版本 `v0.1.21`。各版本的用户可见变更见 [CHANGELOG](./CHANGELOG.md)；进度与发布状态见[路线图 §进度总账](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账)。

## 快速开始

插件已发布到 [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace)。命令行 profile（`web` / `headless` 等）用两步装完：

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # --profile 按你的启动方式选择，可选值见 DSH 文档
```

**DSH Desktop 用户**：如果插件页显示已安装，但 `dsh.profile.bundles` 里没有本包，或一启用就报 `fs` / `sandbox` 重复注册，请按[安装](#安装)的 DSH Desktop 小节用 Desktop 自带的 `dsh` 恢复并冷启动。

tarball、GitHub、本地源码等其他安装方式见[安装](#安装)。

启动后侧栏底部出现 **Folders** 动作（workspace tree 字形；行几何与宿主设置触发行逐像素对齐，见 [ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)）；在 DSH `0.2.1-alpha.3` 及更新的运行时上，新会话页工作区行右端也会出现同一入口（与相邻的工作区/模式选择器同高同字号，无下拉箭头，窄窗口只显示图标）。也可以直接在会话里：

```text
/workspace-folders add ~/code/another-repo [--inherit|--read-only|--read-write]
```

之后 Agent 即可在该目录读写、跑 bash——默认 `inherit`，访问级别跟随会话模式。DSH 的动态 working directory 只影响新操作的相对路径和执行目录，切换 cwd 不会新增授权，也不会改变注册表归属。

## 环境要求

**使用本插件**：一个下表中的 DSH 版本（精确匹配，不是范围）。`dsh plugin` 负责安装，无需本地 Node 工具链。

| DSH 系列 | 受支持的版本 |
| --- | --- |
| `0.1.5` | `0.1.5-rc.2` |
| `0.1.6` | `0.1.6-alpha.1`、`0.1.6-alpha.2` |
| `0.1.7` | `0.1.7-alpha.1`、`0.1.7-alpha.2`、`0.1.7-rc.1`、`0.1.7-rc.2` |
| `0.2.0` | `0.2.0-rc.1`、`0.2.0-rc.2` |
| `0.2.1` | `0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4`、`0.2.1-alpha.5`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5` |
| `0.2.2` | `0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3` |

DSH 版本不在表内、或 `@deepseek-ai/dsh-*` 各包版本不一致时，插件不会启动，行为等同没装。

**从源码构建 / 贡献**：Node.js `^22.19.0 || >=24`，pnpm `11.25.0`（建议经 corepack 启用）；开发 pin 的 DSH 为 `0.2.2-rc.3`（Node ≥24.9）。

**运行平台**：macOS（Seatbelt）、Linux（bwrap / Landlock）、Windows（root-set ACL runner）。

## 安装

### DSH Desktop：用自带 CLI 安装或恢复

DSH Desktop 的插件页和 CLI **不是等价入口**：插件页的「添加插件」可能只写 `dependencies`，`dsh.profile.bundles` 由随后的「立即启用」单独写入；在运行中的宿主里热启用本插件还可能撞上旧 provider 的重复注册。

1. 完全退出 Desktop，包括托盘图标。
2. 在命令行中使用 Desktop 安装目录内 `resources/runtime/cli/bin` 随附的 `dsh`（必要时把该目录加入 `PATH`）。新装：
   ```sh
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.21
   ```
3. 已安装但缺少 bundle 登记：先 `remove` 再 `add`（只重跑 `add` 不会补登记）：
   ```sh
   dsh plugin --profile desktop remove @dsh-electron/dsh-plugin-multi-root-workspace
   dsh plugin --profile desktop add @dsh-electron/dsh-plugin-multi-root-workspace@0.1.21
   ```
4. 打开 `$DSH_HOME/profiles/desktop/package.json`（未设置 `DSH_HOME` 时通常是 `~/.dsh/profiles/desktop/package.json`），确认 `dsh.profile.bundles` 包含本包。
5. 重新打开 Desktop（冷启动）。

首次安装不再需要为 `koffi` 补 `allowBuilds`：koffi 由宿主提供，本插件把它声明为可选 peer。若 `add` 退出 0 但插件没有进入 `dsh.profile.bundles`，执行一次 `remove` + `add`。热启用冲突的原因、复现记录和实际写入者调查见[故障排查](./docs/troubleshooting/desktop-install-missing-bundle.md)。

### CLI profile 的四种安装来源

`dsh plugin` 支持四种安装来源。以下均以 `web` profile 为例；`headless` 等 CLI profile 同理。DSH Desktop 请使用上一节的 `dsh` 和 `desktop` profile；用 npm 安装的 `dsh` 不能管理 Desktop 的保留 profile。

| 来源 | 命令 | 说明 |
| --- | --- | --- |
| npm 注册表（推荐） | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | 预构建产物，即装即用 |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | 安装时自动从源码构建；`allowBuilds` 需含本包的 exact key，建议锁定版本 |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | 预构建离线包，适合内网/离线 |
| 从源码安装 | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | pnpm `link:` 链接本地 checkout，适合开发调试；无需 `allowBuilds` |

**npm、tarball 与本地路径安装不需要任何 `allowBuilds`**：插件不在生产依赖里携带带构建脚本的包（`koffi` 由宿主提供）。git 来源仍需为本包自身的 `prepare` 授权，但 pnpm 只接受含来源与 commit 的 exact key——按[从 GitHub 安装](#从-github-安装)里 pnpm 打印的那一行原样写入；只写包名不生效。

若 `add` 退出 0 但插件没有进入 `dsh.profile.bundles`，做一次 `remove` + `add`。更多排查见[故障排查](./docs/troubleshooting/install-stops-at-build-approval.md)。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

安装的是预构建产物，不需要构建授权。

### 从 tarball 安装

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# 或从 GitHub Release 资产下载，例如：
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.21/dsh-electron-dsh-plugin-multi-root-workspace-0.1.21.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.21.tgz
```

同样是预构建产物，适合内网或离线环境交付；同样不需要构建授权。

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

GitHub 来源装的是源码，`add` 时会自动构建，不需要手动编译；pnpm 会拦下本包自身的 `prepare`，并打印一行 exact key（含来源与 commit）。把那一行原样写进 `allowBuilds` 后重跑 `add`：

```yaml
allowBuilds:
  # 键与值都来自 pnpm 报错中 “Add the package to allowBuilds” 的示例；
  # 只写包名、不带来源与 commit 的键对 git 来源不生效。
  '@dsh-electron/dsh-plugin-multi-root-workspace@github:cherrchen/dsh-plugin-multi-root-workspace#<commit>': true
```

建议锁定版本（如 `#v0.1.21`），让后续推送无法悄悄改变实际运行的内容：

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.21
```

### 从本地源码安装

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true
pnpm install
pnpm build
dsh plugin --profile web add /path/to/repo
```

> [!TIP]
> `dsh` 不在 PATH 里时（例如用源码仓库跑 DSH），把命令里的 `dsh` 换成 `pnpm dsh`。

## 运行方法

开发自检：

```sh
pnpm lint && pnpm typecheck
pnpm test
pnpm kernel:probe
pnpm smoke
pnpm docs:check
```

安装进 DSH 运行时并验证组合：

```sh
dsh plugin --profile web add /path/to/repo
dsh --profile web --dump-config | grep -A3 'multi-root'
```

预期输出：

```text
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  disabled: true
--
# == @deepseek-ai/dsh-base, patched by @dsh-electron/dsh-plugin-multi-root-workspace
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true
--
# == @dsh-electron/dsh-plugin-multi-root-workspace
- id: multi-root-compat
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/compat'
- id: multi-root-fs
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/fs'
- id: multi-root-sandbox
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/sandbox'
- id: multi-root-providers
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/providers'
- id: multi-root-scope
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/scope'
  config:
    toolAccess: {}
- id: multi-root-registry
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/registry'
  config:
    sharedStorageRoot: !!js dshHomePath('storages')
    leasePath: !!js dshHomePath('storages/multi_root_workspace.lock')
    maxAdditionalRoots: 16
- id: multi-root-instructions
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/instructions'
  config:
    maxBytes: 65536
- id: multi-root-lsp
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/lsp'
- id: multi-root-workspace-files
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/workspace-files'
- id: multi-root-command
  name: '@dsh-electron/dsh-plugin-multi-root-workspace/command'
- id: multi-root-client
  name: '@dsh-electron/dsh-plugin-multi-root-workspace'
```

即上游 `fs-sandbox` 与 `sandbox` 两行被禁用、由插件同名服务接管，插件自身的 `multi-root-*` 行全部挂载。启动后侧栏底部会出现 **Folders** 动作（workspace tree 字形）；DSH `0.2.1-alpha.3` 及更新的运行时还会在新会话页工作区行右端显示同一入口。

## 使用方法

### 命令

```text
/workspace-folders [list]                                                   # 列出主根与附加根（含每根访问级别与状态）
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # 不带路径时打开系统目录选择器；新登记默认 inherit
/add-dirs [absolute path] [--inherit|--read-only|--read-write]              # /workspace-folders add 的快捷命令
/workspace-folders access <order|path> inherit|read-only|read-write         # 切换访问级别（扩权要求该根此刻可用）
/workspace-folders skills <order|path> on|off                               # 独立切换附属根 Skills，不改变写权限
/workspace-folders alias-id <order|path> <kebab-case>                        # 编辑稳定 Skill 命名空间
/workspace-folders alias <order|path> [alias]                               # 不带别名则清除已有别名
/workspace-folders remove <order|path>                                      # 序号即 list 输出的编号
/workspace-folders reveal <order|path>                                      # 在文件管理器中显示
/workspace-folders isolate-profiles [--apply]                               # 检查 $DSH_HOME profile 依赖导入方式与多链接文件；--apply 写入 copy 配置
/workspace-folders help                                                     # 查看命令帮助
```

路径可带引号；与已有根重复、嵌套在已有根内部、或就是主根本身的路径会被拒绝。

访问级别是三态的（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)，语义细节见[使用指南](./docs/guide/README.md#访问级别数量上限与-per-tool-封顶)）：`inherit` 跟随会话模式——`workspace-write` 可写、`read-only` 拒写、`danger-full-access` 不受限；`read-only` 在任何模式下都拒写（包括 Full-access）；`read-write` 固定在只读会话里仍可写。唯一例外：用户在单次调用上批准的 `danger-full-access` 一次性提权会解除该调用的只读根与 per-tool 封顶拒绝（`$DSH_HOME` 与 Registry 失权降级除外，[ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)）。旧版插件登记的可写记录升级后按 `inherit` 读。每个主根最多登记 16 个附加根（`maxAdditionalRoots` 配置可调至 64）。宿主还可以在 `multi-root-scope` 行配置 `toolAccess`，例如 `{ bash: 'read-only' }` 让 bash 永远不能写任何附加根（仍可写主根；同一批准的一次性提权对该调用同样解除封顶）。

`add` 后执行 `list` 的预期输出（`workspace-write` 会话，website 登记为只读）：

```text
Workspace root (primary; access follows the current sandbox mode): /home/me/monorepo
  1 /home/me/payments-service [支付] (inherit)
  2 /home/me/website (read-only)
2 of 16 additional roots.
Writable additional roots under the current mode: 1 of 2.
```

### 附属根 Skills

发现附属目录的 `.dsh/skills` 和 `.agents/skills`，首个模型步骤可见名称与描述，正文按需加载。主根使用 `/skill-name`；附属根始终使用 `/alias-id:skill-name`，可在 Slash 菜单补全或手动输入。模型通过原生 `skill` 工具调用内部名称；工具日志中可能显示内部 ID，人类菜单只列命名空间引用。

新登记的 `inherit` / `read-write` 根默认开启，`read-only` 根默认关闭；Workspace Folders Dialog 可独立切换 Skills 并编辑 `aliasId`。显示 Alias 的修改不改变 `aliasId`。只有登记权限的实际变化才重置开关；切换会话沙箱模式、同值权限设置和未改变权限的重新登记都保留手动选择。只读根开启 Skills 后仍没有写权限。

Settings → Plugins → Multi-root Workspace 中的 **启用附属根 Skills** 控制全部附属根，默认开启。关闭后阻止新的发现与调用，保留每根选择；恢复后按原值发现。主根 Skills、指令、LSP、文件浏览及沙箱权限不受此开关影响。旧版宿主使用兼容的插件设置页。命名空间引用按普通用户输入显示，不添加背景、高亮或点击预览；草稿内的原生 Skill 高亮暂不支持冒号引用。

升级时旧 `inherit` / `read-write` 登记会默认开启 Skills。持久化迁移保留原有 grant；旧版写回可能剥离 `aliasId` 和手动开关，再升级时重新按默认值迁移，**不保证 Skills 配置无损降级**。如需保留选择，降级前备份 `$DSH_HOME/storages/multi_root_workspace.json`。已投递正文仍留在历史中，禁用不会结束已经启动的进程。

架构与验收边界见 [ADR-0023](./docs/decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md)，实施和平台状态见[路线账本](./docs/plans/active/2026-09-12-multi-root-workspace.md#multi-root-skills-架构验证2026-10-23)。

### Worktree 附加根建议（实验性，默认关闭）

primary root 本身是 Git main 或 linked checkout 根时，插件会发现与本仓库共享 common git dir 的其他 worktree —— 包括会话开始前就存在、由终端、IDE、forge 或其他 DSH 创建的 —— 并在用户确认后把该 worktree 的源码树登记为附加根（默认 `inherit`，可逐行选择权限）。发现只读取插件自己打开并解析的 Git 元数据（`.git` 指针、admin、common 的 config/HEAD/index 与完整祖先链），**不启动任何 Git 子进程，也不解析 commit 对象**，并且**不会自动添加或删除**。该功能**实验性，默认关闭**，需在插件详情卡显式开启。

默认 pool 没有特殊规则：主仓库作为 primary 时 `.agents/worktrees/<id>` 位于 primary 内，按既有包含规则过滤；primary 本身是 pool worktree 时，兄弟 worktree 仍是候选（仍受登记、上限与「不再提示」约束）。submodule（含 linked worktree 本身是 submodule）、bare 派生的 linked worktree、`--separate-git-dir` 主 checkout、`extensions.worktreeConfig`、`core.repositoryformatversion=1` / `--relative-paths` 以及 split/sparse index 一律不提示。

提示按 workspace 共享、按 session 的沙箱模式过滤：读写会话可确认读写，只读会话显示只读，Full-access 不提示。确认 Dialog 加宽到适合一行放下名称、路径、分支和权限；候选改为连续列表（不再每个 worktree 一张卡片），每行显示文件夹名、绝对路径、检测到的 Git 分支（detached HEAD 不显示）和登记权限选择器；权限默认 `inherit`，可逐行改为只读或读写。**恰好一个可见候选时仍显示单个确认行；两个及以上时显示可勾选列表**（B 默认勾选，A 默认不勾且内联披露），一次确认多个目录。登记是 workspace 级的，**其他读写会话也会获得所选权限**，主 checkout 行会明确披露影响范围；确认后由 Registry owner 在既有串行队列内再次复验，并按每行选择的权限写入登记；复验覆盖 primary/candidate、primary/common/admin 的 HEAD 语法与目录身份；等待期间任何变化都会让该项失效（`worktree/prompt-stale`），列表中的其余项继续处理，失效项保持未登记。

发现提示本身是非模态常驻卡片：新会话（Hero）页显示在顶部居中，纵向与官方 Toast 对齐，官方瞬时 Toast 出现时临时下移避让；对话页显示在 Header 下方的水平居中位置，不再占用输入框所在的右下角。卡片随主题明暗切换；操作为「查看」和「稍后提醒」拆分按钮（外围与中间分割线同为一条细线）：左半文字按钮直接应用默认档位（直到出现新 worktree），右半 chevron 按钮打开下拉（直到出现新 worktree / 7 天后 / 30 天后）；选择后即关闭提示。卡片右上角另有一个正圆关闭按钮：它只关闭本次提示、不写任何提醒状态（本 Host 生命周期内不再自动提示，重启后候选重新可见），与写持久延迟的「稍后提醒」和写 ignore 的「永久不再提示」区分。提示关闭后，可从 Workspace Folders 面板「重试」右侧的「Worktree 建议」重新打开确认面板；手动入口在没有任何可添加候选时，面板关闭后会以官方 info Toast 提示「当前没有可添加的 Worktree。」（自动会话激活的空结果仍静默）。

worktree 被删除或移动后，Workspace Folders 面板会显示徽标；**永不自动清理**。只有登记路径被确认缺失（`ENOENT`/`ENOTDIR`）且 `rootId + path + addedAt` 仍匹配时，面板才提供清理：批量入口在「附属工作目录」标题右侧（仅当存在可清理项时出现），每条可清理行末尾另有红色删除按钮，两者打开同一个覆盖在面板上的确认 Dialog（标题、数量、不可撤销说明、取消与确认）。这类失效行只保留 显示名 + 权限徽标（通常显示「不可用」）+ 路径 + 红色删除 + `…` 菜单；不再显示状态橙字、路径复用提示、技能开关、reveal 与重新登记，目录重新出现后由下一次面板刷新按 Registry 的路径级恢复重新分类。目录仍存在、无法访问，或旧 admin 消失但 checkout 仍有效时只提供普通 Remove，行内容不变。缺失根会继续占用 `maxAdditionalRoots`，直到清理或手动移除；**清理前，同一路径出现的新目录可能继承旧授权**——该风险改为在删除确认 Dialog 中披露（单条与批量各有对应文案），不再常驻列表。

Settings → Plugins → Multi-root Workspace 同一张设置卡中的 **启用 Worktree 附加根建议** 带“实验性”Tag，**默认关闭**，与「启用附属根 Skills」相互独立；只有显式开启后才进行发现、提示与专用清理。关闭后已有登记根仍按普通根管理。决策与验收边界见 [ADR-0039](./docs/decisions/ADR-0039-worktree-aware-root-suggestions.md)。

### 主 checkout 授权（A）

当 session 的 workspace 本身是 linked worktree、且当前为 `workspace-write` 时，插件会提示把该仓库的**主 checkout 根 `<main>`（共享 common 的父目录，通常是主 checkout 的源码根）**登记为附加根（默认 `inherit`，可在行内更改权限）。对话框明确显示实际路径与范围：主 checkout 的源码树、共享 config、hooks、refs/objects 以及所有 worktree 的 admin 数据，可能影响同仓库的其他 checkout；登记仍是 workspace 级。

A 只在该 primary 的完整快照证明 common 身份、且 `<main>/.git` 仍是该 common 的真实目录时出现。它补上受限 `workspace-write` 会话执行 `git add` / `git commit` 的写入缺口，同时**把主 checkout 的源码树纳入授权**。默认 pool 的 primary 位于 `<main>` 内，`primary-overlap` 会拒绝，因此 pool 没有 A；`--separate-git-dir` 时推导出的路径可能是 store 的父目录而非真正主 checkout，对话框会显示实际路径并提示核对。等待确认期间，primary/admin/common 的文件系统身份、双向指针、admin HEAD、祖先索引、主根身份或 `<main>/.git` 被替换都会让提示失效，不会写入。

`read-only` 与 `danger-full-access` 不提示 A；模式变化或关闭开关会作废旧提示。A 根不进入 worktree 清理映射，删除 linked checkout 也不会清理它；需要撤回时使用普通 Remove。受限 shell 的真实 Git 旅程按内核能力探针执行，宿主无法嵌套沙箱时显式 skip 并打印原因。

### SSH 远端环境（实验性，默认关闭，未发布）

Issue #32 的多执行环境能力以实验性开关形式随默认组合发货：插件详情设置卡的 **SSH 远端环境** 带"实验性"警示标签并**默认关闭**，开启前须阅读风险确认（Agent 可在配置的远端主机执行命令与复制文件，凭据的持有方由托管档位决定），取消或关闭弹窗不保存。设置卡只保留启用开关；**凭据托管档位**在 Workspace Folders 面板的“管理 SSH 远端”对话框 →“模式设置”中切换，三档互斥：

- **个人（默认）**：凭据由本机 Host 进程直接持有，**不承诺 Agent 拿不到密钥**；适合个人机器、一次性 VM 或可信 Agent。
- **团队**：独立 broker 账户托管凭据，复制目的须为 chroot SFTP；显示四个 broker 字段（manifestPath / socketPath / brokerUid / credentialRoot）可就地保存。适合共享构建机。
- **硬化**：broker + 配额/审计/吊销 + 专用账户与独立写者，由部署 profile 配置，“模式设置”只显示只读说明。

开关开启时向更低隔离档位切换会再次经过风险确认。Registry 按档位读取清单来源（personal → `remoteEnvironments.personalPath`；team/hardened → `remoteEnvironments.manifestPath`，默认 `/etc/dsh-ssh-broker/manifest.json`）并建立远端控制面。Workspace Folders 面板的“远端环境”区块只保留**远端工作区列表**（沿用附属工作目录的行样式，平台显示为 Linux / macOS，保留登记/移除）和“添加 SSH 远端…”/“管理 SSH 远端…”两枚入口；新增连接、已有连接、SSH Key 与模式设置都在独立对话框的四个 Tab 中完成。对话框表单复用宿主 primitives：`Input`/`Button`/`Tag` 在所有受支持版本可用，`Checkbox`/`SegmentedControl` 在新版本使用、旧版本回退为同语义自绘控件；字段采用两列 grid 与持久 label。

**个人模式走通一次**（在“管理 SSH 远端”对话框中完成）：打开 Workspace Folders →“添加 SSH 远端…”→ 在“添加连接”Tab 填写主机、账号、平台（Linux / macOS）与远端工作目录，按需勾选允许命令执行 / 允许文件传输 → 选择 ssh-config 别名或托管凭据；没有凭据时切到“SSH Key”Tab 生成密钥 / 导入私钥 / 保存密码 → 扫描主机钥并选择指纹 → 若使用托管凭据，在“已有连接”Tab 点击横幅把 `Include` 写入 `~/.ssh/config`（自动备份）→ 测试连接 → 安装 helper（可选，走 SFTP 时可跳过）→ 密码凭据可再装访问密钥 → 在“已有连接”Tab 添加本项目绑定（选择本地根与远端路径、动作与传输方向）→ 回到 Workspace Folders 的远端工作区列表点击 Register → 此后 Agent 才能用 `remote_copy` / `remote_bash` 触达该远端。秘密输入提交即清，任何 RPC 应答都不含私钥或密码字节。

模型侧的 `remote_copy` / `remote_bash` 与能力投影在 team/hardened 下还要通过 broker 凭据隔离证明：broker 块由部署方在专用 profile（hardened）或“模式设置”字段（team）提供，任何一步失败（SSH 兼容门禁、控制面未就绪、`danger-full-access` 会话仅对 hardened 拒绝、证明失败）都不安装工具。每次远端调用仍由 Registry 排序准入。关闭开关即卸载全部远端子树并把控制面恢复为 `disabled`（无 `remote-1` 监听、无远端域）。各档保护边界、文件布局、RPC 拒绝码见 [SSH 远端环境参考](./docs/reference/ssh-remote-environments.md)；team/hardened 的部署步骤与回滚见[控制面参考](./docs/reference/multi-environment-control-plane.md)。

### 面板

侧栏底部的 **Folders** 入口，以及 DSH `0.2.1-alpha.3` 及更新运行时新会话页工作区行右端的同一入口，打开的是同一个对话框；它列出主根与附加根，支持添加、移除、别名、切换只读/可写、复制路径与在文件管理器中显示。新会话入口与相邻的工作区/模式选择器同一套几何与交互，但因为打开对话框而不是下拉菜单，**没有 chevron**；它随工作区行的可用宽度收缩（label 省略号），余量不足 88px 时只保留 28×28 图标（名称仍由 `aria-label` / 悬停提示承载），任何列宽下都不会越过输入卡右缘。首条消息发出后 hero 行消失，侧栏入口照常可用；旧运行时只有侧栏入口。侧栏入口的图标是 workspace tree 字形，与本插件其他入口同族；行几何在 19 个旧几何版本（`0.1.5-rc.2` … `0.2.1-rc.5`）与 5 个新几何版本（`0.2.2-alpha.2` … `0.2.2-rc.3`）上都与宿主设置触发行逐像素对齐，一份「宿主 token + 旧值 fallback」配方同时命中两代，精确公式见 [ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)。按钮高度跟随同一列设置行的 occupant，让两处 hover 药丸同尺寸：DSH `0.1.7-rc.2` 及更早的 7 个版本里那是 42px 的设置触发器，本入口沿用 42px；从 `0.2.0-rc.1` 起设置行是账号菜单 launcher（已登录 44px / 未登录 32px / rail 36px），本入口只用账号 launcher 自己的 `data-signed-out` 标记跟随高度，标记缺席（例如宿主改名）时回退 42px，rail 固定 36px；图标/文字左缘、圆角与 hover token 不变。同槽共存：本入口挂载期间 `sidebar.footer.action` 槽锚点是纵向列，同槽另一个 footer action 真的渲染时两者各占一整行、都可见可点；本入口不隐藏、不让位，注册的 id/order/label 不变，也不读取槽账本或观测其他插件的 DOM；只有本入口时布局与宿主单行布局逐像素相同，浏览器不支持 `:has()` 时规则被丢弃并回到宿主布局。

### 模型侧

附加根的拓扑信息会注入系统提示词，让模型知道当前有哪些目录可用，授权变化时信息随之更新，不需要向模型提供新的工具。

## Auto Review 适配（实验性，默认关闭）

需要 Auto Review 多根上下文时，在插件管理器的主包行列表中启用默认关闭的 [Auto Review 入口](./src/auto-review/README.md)；同一详情页设置卡中的「多根 Auto Review（实验性）」开关与该行开关等价，默认同样关闭。该集成面向 DSH `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3` 九个精确发布；普通安装保持原支持范围且不会启用或选择 Auto。

## 项目结构

```text
.
├── src/
│   ├── roots.ts                      纯规则层：canonical 化、冲突校验、登记状态分类（available/missing/redirected/invalid）
│   ├── registry.ts                   根注册表：dsh-storage-domain 持久化，唯一存储核心与 Host facade，store-wide 准入/变更排序
│   ├── registry-lease.ts             跨进程 Registry Authority：POSIX flock（进程死亡由内核释放）
│   ├── registry-lease-win32.ts       同上，Windows named semaphore 实现
│   ├── scope.ts                      ctx.multiRootScope：唯一的授权源，兼发模型可见的拓扑快照
│   ├── fs.ts                         多根文件系统 provider（进程内 fence，子类自上游 LocalFileSystem）
│   ├── sandbox.ts                    多根内核沙箱 provider（子类自上游 LocalSandboxProvider）
│   ├── dialects.ts                   Seatbelt / bwrap / Landlock profile 的识别与附加 grant 拼装（不认识即响亮报错）
│   ├── windows-*.ts                  Windows root-set ACL runner 与 restricted-token 执行
│   ├── containment.ts                路径包含判定（词法快速路径 + dev/ino 别名回退）
│   ├── instructions.ts               附加根 AGENTS.md / CLAUDE.md 的发现、增量投递、预算与撤回（顶层 + 本会话触碰过的子目录，经 agent/pre-step 注入）
│   ├── lsp.ts                        附加根按所在根初始化独立 LSP workspace
│   ├── workspace-files.ts            Files 页签附加根文件浏览的 host 路由与 confinement
│   ├── compat.ts                     multi-root-compat 启动门禁（版本 allowlist 与混装判定）
│   ├── compat/                       版本差异适配层：dsh-version / sandbox-confine / agent-instructions / llm-message 等（可选 peer 按需加载）
│   ├── command.ts                    /workspace-folders 命令与面板 RPC 的 host 半部
│   ├── worktrees.ts                 Worktree 附加根建议行：发现/激活/watcher、prompt 队列与等待者、确认与显式清理
│   ├── worktrees/                   受控 Git 元数据快照（config/HEAD/index/祖先链）、inventory、sidecar 与 owner 复验（不启动 Git）
│   ├── worktrees-contract.ts         Worktree 端点的双端严格契约（判别联合，禁止 retry 字段）
│   ├── contract.ts                   面板线协议（zod 双端校验，可内联进浏览器 bundle）
│   └── client/                       浏览器半部：侧栏动作、Folders 对话框、Files 页签根切换器、双语词典
├── tests/                            差分 parity、方言真实执行矩阵、契约往返、组件与 locale 门禁、跨进程 lease e2e、指令注入
├── scripts/                          冒烟（compose / behavior / journey）、文档与内核 runner 检查、兼容性契约检查、升级流程
└── docs/                             需求、架构、决策记录（ADR）、计划、开发工作流
```

## 贡献指南

欢迎 Issue 与 PR：

1. 先读 [`AGENTS.md`](./AGENTS.md)（仓库级规则）与[开发工作流](./docs/development/plugin-development-workflow.md)（环境、命令、运行时支持矩阵、升级流程）。
2. 从 `main` 拉分支；提交信息遵循 conventional commits（`feat` / `fix` / `perf` / `refactor` + scope），参见现有历史。
3. PR 前本地必须全部通过：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm docs:check`、`pnpm smoke`（CI 按同序执行，先 build 后 test）。
4. 影响行为的变更需同批更新 `docs/` 下的对应文档；README 保持中英双语同步；有取舍的工程决策请新增 ADR。
5. 硬约束：**不修改上游仓库（deepseek-harness）任何包**；插件只做 out-of-tree 扩展。

## 已知限制

### 插件功能

- 附加根的指令文件按需到达模型：根目录顶层的那一份在会话第一步之前注入，子目录里的那一份在本会话**成功**触碰过该目录之后注入；nested 文件只会在其目录被考察到时重新检查（根层每一步，子目录依赖已投递或有新触碰），投递状态是进程内的（resume 后可能再告知一次）；官方识别 `read` / `write` / `edit`，启用 OPS 兼容模式后，OPS 工具经 live 证据同样驱动投递（resume 后 OPS 历史缺 live 证据不参与投递）。主根与 user-global 的指令链仍由上游负责，本插件不重复注入（[ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)）。
- 多 Host 共享同一登记服务：只有一个 Host 管理存储，各实例逐操作取得授权；断线停止新附加授权，权威退出后按内核锁接管。限同机器、同用户及同锁命名空间；Linux 共享连接需要 SO_PEERPIDFD，Windows 限同登录会话。旧进程/PTY 保留启动快照（[共享架构](./docs/architecture/registry-authority-service.md)）。
- 支持矩阵是精确版本 allowlist：宿主版本不在清单上、或核心包混装了不同版本时，`fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` 六行**不启动**，组合退化为"没装这个插件"（[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。
- Windows 多根 runner 继承上游 partial enforcement、caller-owned 目录及 private temp 分离条件；已启动进程保留启动时根集合，后续进程使用更新后的集合（[ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- **Windows 上的网络与设备路径不能成为附加根**：UNC（`\\server\share`）、`\\?\`、`\\.\` 与映射网络盘在登记时即以 `unsupported-path` 拒绝——restricted token 的 capability SID 无法绑定 SMB 访问（[ADR-0011 修订](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- **Windows 受限 shell 是 pwsh，不含 Git Bash**：MSYS 在 restricted Low-integrity token 下无法启动（上游 runner 与插件 runner 表现一致，属上游限制）；上游 runner 的 confined 子进程因继承 ignore-Ctrl+C 标志而收不到 Ctrl+C，插件 runner 下子进程能收到并由 runner 镜像其退出码。
- 附加根访问级别是三态的：新登记默认 `inherit`（跟随会话模式），`--read-only` 在任何模式下都拒写（包括 Full-access；唯一的例外是用户针对单次调用批准的一次性提权，见 [ADR-0036](./docs/decisions/ADR-0036-approved-escalation-override.md)），`--read-write` 固定在只读会话里仍可写（写授权问题，不是读 confinement；[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。已启动的进程与持久终端保留启动时的 deny 集——一个在某根变为只读之前就启动的终端保持不受限，直到重启；cap/access 变化只约束之后的调用与新进程（[ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)）；提供 workingDirectory 的宿主可以把附加根作为后续工具的执行目录，Session 原始项目与登记身份不变（[ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)）。
- **上游选择 Landlock 的 Linux 主机上，受限 Full-access 需要 bwrap**：Landlock 的 allowlist 表达不了「全部可写、除这些根」，该组合改选 bubblewrap 拼出拒写边界；主机没有可用的 bwrap（未安装或禁用非特权 userns）时，存在任何拒写边界（只读根或受保护的 `$DSH_HOME`）的 Full-access 命令在启动前失败关闭。启用 bwrap，或在该主机上避免在 Full-access 下使用显式只读根（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- 附加根文件树由 **Files 页签的根选择器**承载：头部入口列出主根与全部附加根，旁边仍显示选中根的完整路径；选中附加根时逐字节复刻的上游 Files 树体接管树区（懒加载目录、原生行式与图标、watch 自动刷新、文件点击进宿主 viewer、header 原位提供手动刷新），header 右侧「在应用中打开」按钮同时由逐字节复刻的上游控件顶替、对选中根而非主根发起打开；切回主根即恢复原生视图；对话框回归纯管理。附加根行另提供与主根一致的行右键菜单（文件行、目录行；文件预览的 Folder 导航树同样生效），并按选中根提供工作区搜索（页头搜索钮、搜索栏、命中高亮结果树、偏好浮层与隐藏项过滤）；两者只在宿主暴露对应结构时出现——行右键要求 `useContextMenu`（`0.2.2-alpha.3` 起），搜索要求 `workspaceFiles.search`（`0.2.2-rc.2` 起），更早宿主上不绑定行菜单、不渲染搜索入口，视图保持不变。该接管依赖上游 `data-*` DOM 钩子，钩子失效时静默退化为原生观感（[ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)）。LSP 按附加文件所在根初始化独立 workspace；需要宿主配置对应语言服务器（[ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。已知边界：原生 Files 快捷键 **Cmd+P** 仍聚焦被接管隐藏的原生搜索框，因此不把原生快捷键当作附加根搜索入口——Files 页与预览导航树的搜索面都不响应它（[ADR-0041](./docs/decisions/ADR-0041-additional-root-workspace-search.md)、[ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)）；预览导航树的搜索记录按 `(pane, root)` 保存，与 Files 页的 `(tab, root)` 分开，因此同一 pane 的 Files 页查询不会带进预览；结果当前行只标记、不自动滚动；关闭 Folder 或同一 pane 换根会丢弃未保存的设置草稿（[ADR-0043](./docs/decisions/ADR-0043-additional-root-preview-navigator-search.md)）。
- 第三方插件接管整个 Files 页签（以 `priority: "extension"` 注册 `files` kind）时，根切换器与附加根浏览不可用；插件弹一次官方 info 级瞬时提示，接管解除后可再次提示，根管理仍可从侧栏「工作区目录」与 `/workspace-folders` 完成（[Issue #47](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/47)）。
- 命令的输出文案为英文（host 侧没有活动语言信息），面板文案中英双语跟随界面语言。
- Workspace Folders 面板是「侧栏底部动作 + 对话框」，不是独立全屏面板：`sidebar.footer.action` 是所有受支持版本都提供的插槽，而 `sidebar.panellist`/`main` 不是。DSH `0.2.1-alpha.3` 起额外在新会话页的 `conversation.hero.options` 槽挂一个增量入口：它与相邻的工作区/模式选择器同几何、无 chevron，按工作区行内实测的可用余量收缩，余量不足 88px 时退化为 28×28 图标按钮（上游 options 容器是 `flex: none`，插件不改 DSH，只测余量并夹住自己；探针认不出行结构时回落到 560px 视口兜底）；该槽在旧运行时缺席时注册静默不触发，侧栏入口不受影响（[ADR-0037](./docs/decisions/ADR-0037-conversation-hero-workspace-folders-entry.md)）。侧栏入口的 rail（折叠态）圆角有自己更早的分界 `0.1.6-alpha.2`：22 个受支持版本与宿主同为 12px 圆角方，最老 2 个版本（`0.1.5-rc.2`、`0.1.6-alpha.1`）宿主画圆而插件画 12px 圆角方，是已记录的圆角偏差（无 ink/布局影响）；`@media (hover: hover)` 包装只在 5 个新几何版本存在，插件保持不包装，触屏上与这些版本有 hover 反馈差异（[ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)）。侧栏入口的高度跟随同一列设置行的 occupant，依赖账号 launcher 的 `data-signed-out` 结构标记（CSS `:has()` 依赖，不是槽位契约）：`0.1.7-rc.2` 及更早的 7 个版本沿用 42px 设置触发器高度；`0.2.0-rc.1` 起未登录 32px / 已登录 44px，rail 固定 36px；标记改名或消失时回退 42px（不会误设尺寸），只影响高度（[ADR-0044](./docs/decisions/ADR-0044-sidebar-footer-row-alignment-and-coexistence.md)）。

### OPS 适配

当前实现作为 **OPS 兼容模式（实验性，默认关闭，可能存在限制）** 开放：在 `Settings → Plugins → Multi-root Workspace` 中设置 `multi-root-ops-compatibility.enabled`，默认 `false`，必须显式开启。该功能仅允许在现有精确支持矩阵内的 DSH `0.2.*` 上启用；`0.1.*` 即使手工配置 `enabled: true` 也保持关闭，不提供旧版 Settings UI（[版本范围决定](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#ops-版本范围修订2026-11-06)）。 从设置界面开启时，须阅读官方风险弹窗、勾选已了解限制并再次确认；确认前保持关闭，取消、关闭弹窗或按 Esc 均不保存开启设置。

- **开启**：激活 OPS 执行保护、实时活动与 Review 增强。Full-access（`danger-full-access`）在已验证的 macOS/Linux 车道用内核围栏保护 explicit RO/cap deny；Windows 有 deny 时在 Worker 准备前保守拒绝 OPS 执行（包括读取），尚不支持该组合下的受保护准备与合法写入。WW/RO 一旦存在不可写附加根或工具只读上限，整次 OPS 执行调用（包括读取/page）会在准备与正文前拒绝。所有模式在 Registry 失权时拒绝 OPS 执行调用，纯发现/发布除外。没有执行域或当次有效 profile 证明的 subprocess 启动也会拒绝，防止后台清理绕过边界；这可能连带拒绝第三方后台进程，但不拦截面板中用户自己的终端。
- **关闭**：OPS 恢复本轮适配前的行为，不提供这些兜底——**显式只读附加根可能被 OPS 写入**。普通多根功能、原生工具围栏和 Auto Review 自身开关不受影响。已投递的指令不会回溯抹除，已进入保护域的调用与已启动进程保留原快照；关闭后开始的新调用不再激活本次适配。
- **实验限制**：仅提供 Phase A live 活动索引，无持久事件桥。开启时，resume 后 OPS 历史缺 live 证据、动态 pending（replace/batch/result/bash/unknown）会使 Review 技术失败；非白名单诊断如 `ops_status` 也受此保守规则影响。

具体已知缺口：

- **dsh-ops 只读限制绕过（F01，历史基线）**：审计版本在 Full-access 下，OPS Native `ops_write_file` 实际写入了显式只读附属根，而原生 fs 同次对照被拒。启用 OPS 兼容模式时，本轮有限适配已在 Full-access 下复验 explicit RO/cap deny 对 OPS Native 与真实 PTC 生效（deny 执行复验见[审计§16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)），版本、测试范围与原始证据见[兼容性审计](./docs/reviews/dsh-ops-compatibility-audit.md)。
- **dsh-ops 的合法写入与子目录指令缺口（F04/F05，历史基线）**：WW 下 inherit/固定读写附属根及 RO 下固定读写附属根被 OPS 预检拒写的问题未解决；OPS 读取不触发子目录指令发现（F05）已在启用模式的本轮 live 索引 + 真实 AgentLoop 下复验恢复（Native 与 PTC 成功触碰的子目录指令进入下一模型请求，见[审计§16](./docs/reviews/dsh-ops-compatibility-audit.md#16-适配后复验)）；不影响已验证的根级指令和 Skills 路径。
- **Linux bwrap 的 WW batch/result 降级（F07）**：审计版本的共享 Registry 下，所有到达启动分支且取得有效 cache 的 `ops_batch` / `ops_result`（含 `page`）都会因 confine 后追加 bind 而失去 argv 归属证明，源码路径将拒绝 Worker 启动并报 `EXECUTOR_UNAVAILABLE`。函数级冲突已复现，Linux 端到端未测；普通 RO、Landlock 和无 cache 对照不在此结论内。需 OPS 提供 confine 前的 cache 声明接口，目前没有已验证的 MR 单侧缓解，见[审计 F07](./docs/reviews/dsh-ops-compatibility-audit.md#131-n1--f07confine-后的-cache-bind-与严格证明冲突)。
- **其他 OPS 可用性边界**：共享 WW 下，调度外 purge 无有效 admission 时会被拒，结果缓存可能残留并告警；PTC 嵌套调用及后台 Bash 也有证明归属/过期导致的拒绝风险。本轮已完成保守拒绝边界的三平台验证；正常后台与清理能力仍未恢复，且已无限期延后，见 [ADR-0029 最终范围](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#最终范围与无限期延后2026-11-05)。

P5 的本仓兜底不修改 OPS：合法附加根写入仍可能被误拒，后台结果缓存可能因拒绝清理而残留；legacy 非共享模式下，WW/RO 的 PTC 也可能在启动代码进程前被拒。持久活动仍关闭：DSH 的 `appendPluginRecord` 明确禁止外部插件调用，不能用普通事件或私写日志代替。P6 已按限定范围完成技术验收；P5 剩余功能及全功能兼容验收**无限期延后**，不构成本次完成条件，未来若恢复也仅以实验性能力开放。延期清单见 [ADR-0029](./docs/decisions/ADR-0029-ops-file-authorization-and-activity-adapter.md#无限期延后清单唯一真源)，验收范围见[已完成计划](./docs/plans/completed/2026-11-01-ops-compatibility-adaptation.md)。

本次实验性保守兜底随 `v0.1.15` 发版，不声明完整 OPS 兼容，不提升支持版本。审计 §16 的历史复验发生在本开关加入之前，对应启用路径；后续复跑须显式 `enabled: true`。

## 文档

项目长期文档位于 [`docs/`](./docs/README.md)：

- [版本变更记录（CHANGELOG）](./CHANGELOG.md)
- [用户指南](./docs/guide/README.md)
- [需求](./docs/requirements/multi-root-workspace.md)
- [目标架构](./docs/architecture/multi-root-workspace.md)
- [上游调研](./docs/reference/multi-root-workspace-research.md)
- [决策记录（ADR）](./docs/decisions/README.md)
- [计划](./docs/plans/README.md)
- [开发工作流](./docs/development/plugin-development-workflow.md)
- [常见问题排查](./docs/troubleshooting/README.md)

Coding Agent 的仓库级规则定义于 [`AGENTS.md`](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
