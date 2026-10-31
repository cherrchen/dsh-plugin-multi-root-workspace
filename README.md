<div align="center">

<img src="public/multi-root-mark.svg" width="120" />

# dsh-plugin-multi-root-workspace

中文 | [English](./README.en.md)

</div>

## 项目简介

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 默认把新建工作区所在的目录作为 Agent 的主目录，在默认的工作区读写模式（`workspace-write`）下，沙箱的读写范围也仅覆盖这一个目录。本插件将 DSH 的工作区范围拓展到“一个主目录 + 多个附加目录”。

并非所有项目都是 monorepo。一个开发项目往往由多个独立 Git 仓库组成，跨仓库干活原本得反复换会话。同类工具早已支持在一个工作区添加多个文件夹，本插件把同样的能力带给 DSH：把其他仓库登记为附加根，并按需授予只读、读写或不受限的访问级别，Agent 即可在授权范围内读写。

- **不新增工具**：Agent 照旧使用原生 `read` / `write` / `edit` / `bash`，只是授权的目录变多了。
- **沙箱约束**：附加根可继承会话（主目录）的权限设置，也可单独固定为只读或读写；在只读与读写下，约束不靠系统提示词，而由进程内文件围栏 + 内核级沙箱（macOS Seatbelt / Linux bwrap / Landlock / Windows ACL）执行，文件与 bash 共享同一份授权范围。
- **Files 页签可视化浏览**：Files 页签头部的路径标签同时是根选择器，切换到任一已登记附加根后，树区由上游原生 Files 树的逐字节复刻接管——行结构、图标、展开与滚动记忆、watch 自动刷新逐项一致，打开文件与「在外部应用打开」的操作与主根完全相同；选中结果按页签持久化，打开文件把页签 body 卸下再重挂也不会弹回主根。
- **可选 Auto review（默认关闭）**：fork 上游实验性「自动授权审查」，向 Reviewer 补充附加目录的审查上下文——当前工作区拓扑、各根访问级别与实时指令文件；出厂关闭，需在插件管理器的行列表中显式打开 `@dsh-electron/dsh-plugin-multi-root-workspace/auto-review` 行后生效，启用时接管官方同名 bundle。
- **附属根 Skills**：发现附属目录的 `.dsh/skills` 与 `.agents/skills`，附属根经 `/alias-id:skill-name` 命名空间调用原生 `skill` 工具；每根独立开关、可编辑 `aliasId`，全局设置默认开启。
- **不配等于没装**：未登记附加根时行为与未装插件逐项一致；配置错误一律明确报错，从不静默降级。

当前发布版本 `v0.1.12`。各版本的用户可见变更见 [CHANGELOG](./CHANGELOG.md)；进度与发布状态见[路线图 §进度总账](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账)。

## 快速开始

插件已发布到 [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace)。在 DSH 侧栏的**插件**页点**添加插件**、填入包名 `@dsh-electron/dsh-plugin-multi-root-workspace` 即可安装；也可以用命令行两步装完：

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web       # --profile 按你的启动方式选择，可选值见 DSH 文档
```

tarball、GitHub、本地源码等其他安装方式见[安装](#安装)。

启动后侧栏底部出现 **Folders**（`🗂`）动作，或直接在会话里：

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
| `0.2.2` | `0.2.2-alpha.2` |

DSH 版本不在表内、或 `@deepseek-ai/dsh-*` 各包版本不一致时，插件不会启动，行为等同没装。

**从源码构建 / 贡献**：Node.js `^22.19.0 || >=24`，pnpm `11.25.0`（建议经 corepack 启用）；开发 pin 的 DSH 为 `0.2.2-alpha.2`（Node ≥24.9）。

**运行平台**：macOS（Seatbelt）、Linux（bwrap / Landlock）、Windows（root-set ACL runner）。

## 安装

不使用命令行时，DSH 侧栏的**插件**页提供同一安装入口：点**添加插件**，填入 npm 包名（或 Git 地址、tarball、本地绝对路径）。

`dsh plugin` 支持四种安装来源。以下均以 web profile 为例；桌面端（Electron）把 `--profile web` 换成 `--profile desktop`，安装方式同源。

| 来源 | 命令 | 说明 |
| --- | --- | --- |
| npm 注册表（推荐） | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | 预构建产物，即装即用 |
| GitHub | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | 安装时自动从源码构建；`allowBuilds` 需含本包，建议锁定版本 |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | 预构建离线包，适合内网/离线 |
| 从源码安装 | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | pnpm `link:` 链接本地 checkout，适合开发调试；无需 `allowBuilds` |

**首次安装时 `dsh plugin add` 会以 `[ERR_PNPM_IGNORED_BUILDS]` 失败**：在该 profile 的 `pnpm-workspace.yaml` 里补上下面这行，再执行一次 `add` 即可：

```yaml
allowBuilds:
  koffi: true
```

如果重跑 `退出 0` 但插件没有进入 `dsh.profile.bundles`，做一次 `remove` + `add`。更多排查见[故障排查](./docs/troubleshooting/install-stops-at-build-approval.md)。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

安装的是预构建产物，首次安装需要添加 `allowBuilds`。

### 从 tarball 安装

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# 或从 GitHub Release 资产下载，例如：
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.12/dsh-electron-dsh-plugin-multi-root-workspace-0.1.12.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.12.tgz
```

同样是预构建产物，适合内网或离线环境交付；首次安装同样需要添加 `allowBuilds`。

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

GitHub 来源装的是源码，`add` 时会自动构建，不需要手动编译；但 `allowBuilds` 要写两行——本包自身和 `koffi`：

```yaml
allowBuilds:
  '@dsh-electron/dsh-plugin-multi-root-workspace': true
  koffi: true
```

建议锁定版本（如 `#v0.1.12`），让后续推送无法悄悄改变实际运行的内容：

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.12
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

即上游 `fs-sandbox` 与 `sandbox` 两行被禁用、由插件同名服务接管，插件自身的 `multi-root-*` 行全部挂载。启动后侧栏底部会出现 **Folders** 动作。

## 使用方法

### 命令

```text
/workspace-folders [list]                                                   # 列出主根与附加根（含每根访问级别与状态）
/workspace-folders add <absolute path> [--inherit|--read-only|--read-write] # 不带路径时打开系统目录选择器；新登记默认 inherit
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

访问级别是三态的（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)，语义细节见[使用指南](./docs/guide/README.md#访问级别数量上限与-per-tool-封顶)）：`inherit` 跟随会话模式——`workspace-write` 可写、`read-only` 拒写、`danger-full-access` 不受限；`read-only` 在任何模式下都拒写（包括 Full-access）；`read-write` 固定在只读会话里仍可写。旧版插件登记的可写记录升级后按 `inherit` 读。每个主根最多登记 16 个附加根（`maxAdditionalRoots` 配置可调至 64）。宿主还可以在 `multi-root-scope` 行配置 `toolAccess`，例如 `{ bash: 'read-only' }` 让 bash 永远不能写任何附加根（仍可写主根）。

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

### 面板

侧栏底部的 **Folders** 对话框列出主根与附加根，支持添加、移除、别名、切换只读/可写、复制路径与在文件管理器中显示。

### 模型侧

附加根的拓扑信息会注入系统提示词，让模型知道当前有哪些目录可用，授权变化时信息随之更新，不需要向模型提供新的工具。

## 可选 Auto Review 适配

需要 Auto Review 多根上下文时，在插件管理器的主包行列表中启用默认关闭的 [Auto Review 入口](./src/auto-review/README.md)。该集成仅面向 DSH `0.2.1-rc.2`；普通安装保持原支持范围且不会启用或选择 Auto。

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

- 附加根的指令文件按需到达模型：根目录顶层的那一份在会话第一步之前注入，子目录里的那一份在本会话**成功**触碰过该目录之后注入；nested 文件只会在其目录被考察到时重新检查（根层每一步，子目录依赖已投递或有新触碰），投递状态是进程内的（resume 后可能再告知一次），也只识别 `read` / `write` / `edit` 三个工具名。主根与 user-global 的指令链仍由上游负责，本插件不重复注入（[ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)）。
- 多 Host 共享同一登记服务：只有一个 Host 管理存储，各实例逐操作取得授权；断线停止新附加授权，权威退出后按内核锁接管。限同机器、同用户及同锁命名空间；Linux 共享连接需要 SO_PEERPIDFD，Windows 限同登录会话。旧进程/PTY 保留启动快照（[共享架构](./docs/architecture/registry-authority-service.md)）。
- 支持矩阵是精确版本 allowlist：宿主版本不在清单上、或核心包混装了不同版本时，`fs` / `sandbox` / `registry` / `instructions` / `lsp` / `workspace-files` 六行**不启动**，组合退化为"没装这个插件"（[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)）。
- Windows 多根 runner 继承上游 partial enforcement、caller-owned 目录及 private temp 分离条件；已启动进程保留启动时根集合，后续进程使用更新后的集合（[ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- **Windows 上的网络与设备路径不能成为附加根**：UNC（`\\server\share`）、`\\?\`、`\\.\` 与映射网络盘在登记时即以 `unsupported-path` 拒绝——restricted token 的 capability SID 无法绑定 SMB 访问（[ADR-0011 修订](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- **Windows 受限 shell 是 pwsh，不含 Git Bash**：MSYS 在 restricted Low-integrity token 下无法启动（上游 runner 与插件 runner 表现一致，属上游限制）；上游 runner 的 confined 子进程因继承 ignore-Ctrl+C 标志而收不到 Ctrl+C，插件 runner 下子进程能收到并由 runner 镜像其退出码。
- 附加根访问级别是三态的：新登记默认 `inherit`（跟随会话模式），`--read-only` 在任何模式下都拒写（包括 Full-access），`--read-write` 固定在只读会话里仍可写（写授权问题，不是读 confinement；[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。已启动的进程与持久终端保留启动时的 deny 集——一个在某根变为只读之前就启动的终端保持不受限，直到重启；cap/access 变化只约束之后的调用与新进程（[ADR-0013](./docs/decisions/ADR-0013-per-root-and-per-tool-access.md)）；提供 workingDirectory 的宿主可以把附加根作为后续工具的执行目录，Session 原始项目与登记身份不变（[ADR-0012](./docs/decisions/ADR-0012-session-origin-and-effective-cwd.md)）。
- **上游选择 Landlock 的 Linux 主机上，受限 Full-access 需要 bwrap**：Landlock 的 allowlist 表达不了「全部可写、除这些根」，该组合改选 bubblewrap 拼出拒写边界；主机没有可用的 bwrap（未安装或禁用非特权 userns）时，存在任何拒写边界（只读根或受保护的 `$DSH_HOME`）的 Full-access 命令在启动前失败关闭。启用 bwrap，或在该主机上避免在 Full-access 下使用显式只读根（[ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- 附加根文件树由 **Files 页签的根选择器**承载：头部入口列出主根与全部附加根，旁边仍显示选中根的完整路径；选中附加根时逐字节复刻的上游 Files 树体接管树区（懒加载目录、原生行式与图标、watch 自动刷新、文件点击进宿主 viewer、header 原位提供手动刷新），header 右侧「在应用中打开」按钮同时由逐字节复刻的上游控件顶替、对选中根而非主根发起打开；切回主根即恢复原生视图；对话框回归纯管理。该接管依赖上游 `data-*` DOM 钩子，钩子失效时静默退化为原生观感（[ADR-0015](./docs/decisions/ADR-0015-files-tab-plugin-owned-browsing.md)、[ADR-0016](./docs/decisions/ADR-0016-files-tab-native-tree-fork.md)）。LSP 按附加文件所在根初始化独立 workspace；需要宿主配置对应语言服务器（[ADR-0011](./docs/decisions/ADR-0011-multi-root-workspace-consumers.md)）。
- 命令的输出文案为英文（host 侧没有活动语言信息），面板文案中英双语跟随界面语言。
- Workspace Folders 面板是「侧栏底部动作 + 对话框」，不是独立全屏面板：`sidebar.footer.action` 是所有受支持版本都提供的插槽，而 `sidebar.panellist`/`main` 不是。

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
