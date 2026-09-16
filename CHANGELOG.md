# Changelog

本文件记录每个**已发布**版本对使用者可见的变更。

English: [CHANGELOG.en.md](./CHANGELOG.en.md)

- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
- 安装方式、受支持的上游运行时与已知限制见 [README](./README.md)。
- 每个版本的实施证据、编号口径与发布状态见[路线图 §进度总账](./docs/plans/active/2026-09-12-multi-root-workspace.md#进度总账)；GitHub Release 的正文由 `scripts/release-notes.mjs` 从 commit 历史生成，是本文件之外的完整原始清单。

## [Unreleased]

无。

## [0.1.1] - 2026-09-16

`v0.1.0` 之后的**硬化批次（H1–H4）**：不新增面向使用者的"功能"，而是补齐跨进程、面板权威、上游兼容性与附加根指令四类边界。设计取舍见 [ADR-0007](./docs/decisions/ADR-0007-registry-authority-lease.md)、[ADR-0008](./docs/decisions/ADR-0008-panel-session-derived-authority.md)、[ADR-0009](./docs/decisions/ADR-0009-dsh-compat-contract.md)、[ADR-0010](./docs/decisions/ADR-0010-additional-root-instruction-scope.md)。

### 升级注意（不兼容变更）

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

[Unreleased]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/tag/v0.1.0
