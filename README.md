# dsh-plugin-multi-root-workspace

DSH（DeepSeek Harness）的外部插件 bundle：把 Workspace 的可写范围从"一个目录"扩展为"一个主根 + N 个附加根"，且**不修改上游仓库任何包**。

插件只回答一个问题："哪些目录属于当前 Workspace"，然后用上游同款机制（进程内 fence + 内核 runner 方言）把它们安全地放开；Agent 继续使用原生 `read` / `write` / `edit` / `bash` 工具。

## 项目状态

- **M1（组合与空根直通）已完成并验证**：插件可经 `dsh plugin` 安装，替换 `fs-sandbox` 与 `sandbox` 两行 provider，且在未配置附加根时与未装插件的行为逐项一致。证据见 [`M1 开发计划（completed）`](./docs/plans/completed/2026-09-12-m1-composition-and-passthrough.md)。
- **M2（多根能力）已完成并验证**：附加根经同一份 scope 同时进入进程内 fence 与内核方言 grant（Seatbelt / bwrap / Landlock），由 parity 矩阵、方言单测、拓扑快照与多根冒烟钉住；`read-only` 下附加根同样不可写，空根行为与未装插件逐字节不变。证据见 [`M2 开发计划（completed）`](./docs/plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)。
- **M3（Root 管理与 UI）已实施，并按外部审查意见返工后重新验收**：根注册表持久化在 `$DSH_HOME/storages/multi_root_workspace.json`，`/workspace-folders` 命令与侧栏 Workspace Folders 面板都可以增删根，跨两个 Git 仓库的真实会话旅程由 `pnpm smoke:journey` 覆盖。审查发现的 8 项问题（符号链接替换转移授权、并发丢写、CI 顺序、刷新不重查、手输路径、Reveal 契约、重复 id、主根嵌套）已全部修复并各有回归测试。证据见 [`M3 开发计划`](./docs/plans/completed/2026-09-12-m3-root-registry-command-and-ui.md) 的「外部审查返工」章节。

## 怎么用

在会话里：

```text
/workspace-folders              # 列出主根与附加根
/workspace-folders add <绝对路径>  # 无参数时打开系统目录选择器
/workspace-folders alias 1 支付   # 给第 1 个附加根起别名
/workspace-folders remove 1
```

在 Web GUI 里：侧栏底部的 **Folders** 面板（`🗂`）列出主根与附加根，支持添加（走组合好的目录选择器）、移除、别名、复制路径、在文件管理器中显示与排序，中英文跟随界面语言。

规则：根目录会被 canonical 化（`~` 展开、符号链接解析）后存储，并**记下登记当时授予的那个 canonical 目录**；重复、与主根或某个已登记根互相包含、等于主根、不存在、非目录的候选都会被拒绝并给出原因。

授权按"当前解析结果 == 登记时授予的目录"判定，因此：

- 目录暂时不存在 ⇒ 该根保留登记但**不授予**写权限，状态为 `missing`；
- 登记目录被替换成指向别处的符号链接（或链接链被改动）⇒ 状态为 `redirected`，**不授予**，且绝不会把授权转移到新目标；
- 目录恢复后，执行 `/workspace-folders list`（或在面板里刷新）即可重新授予，**不需要重启**；
- 面板的"重试/刷新"与命令的 `list` 是同一条重新校验路径：它们重新 `stat` 并重新解析每个登记目录，再同步给 fs fence 与内核方言；只读刷新不写存储。

重复 id 的异常记录、缺少"授予目录"字段的旧记录都会标为 `invalid`、不授予，并可在面板/命令里逐条移除（按位置删除，不会一次删掉多条）。

## 已知限制（第一期）

- Windows 的内核级多根未实现：`fs` 写路径覆盖附加根，但受限 bash/PTY 写不进去（非空 scope 时插件输出一次显式告警）；详见[需求文档](./docs/requirements/multi-root-workspace.md)第一期范围。
- 附加根与主根同权（无 per-root read-only）；附加根不能作为 bash/PTY 的默认工作目录（session cwd 语义不变）。
- `workspace-files`（Client 文件树）仍只看主根。
- 命令的输出文案为英文（host 侧没有活动语言信息），面板文案中英双语跟随界面语言。
- Workspace Folders 面板是「侧栏底部动作 + 对话框」，不是独立全屏面板：0.1.5 才有的 `sidebar.panellist`/`main` 插槽在已安装的 0.1.2 桌面运行时上不存在，这样做可以同时兼容两个运行时。

## 快速开始

```sh
pnpm install
export CI=true            # 见开发流程 §8：无 TTY 下 pnpm 的依赖自检会中止
pnpm lint && pnpm typecheck
pnpm build                # 必须先于 test：制品测试读 lib/（未纳入 Git）
pnpm test
pnpm kernel:probe         # 本机能否真跑受限执行；能则后续内核断言必须真跑而非 skip
pnpm smoke                # 组合门禁 + 空根直通/多根行为门禁 + 跨 repo 旅程
pnpm docs:check
```

安装到运行时：

```sh
dsh plugin --profile web add <本仓库路径>
dsh --profile web --dump-config
```

命令、冒烟机制、双运行时矩阵与升级流程见 [`docs/development/plugin-development-workflow.md`](./docs/development/plugin-development-workflow.md)。

## 文档

项目长期文档位于 [`docs/`](./docs/README.md)：

- [需求](./docs/requirements/multi-root-workspace.md)
- [目标架构](./docs/architecture/multi-root-workspace.md)
- [上游调研](./docs/reference/multi-root-workspace-research.md)
- [决策记录](./docs/decisions/README.md)
- [计划](./docs/plans/README.md)

Coding Agent 的仓库级规则定义于 [`AGENTS.md`](./AGENTS.md)。

English documentation: [`README.en.md`](./README.en.md)
