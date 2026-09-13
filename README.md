# dsh-plugin-multi-root-workspace

中文 | [English](./README.en.md)

## 项目简介（What & Why）

DSH（DeepSeek Harness）的外部插件 bundle：把 Workspace 的可写范围从"一个 canonical 目录"扩展为"**一个主根 + N 个附加根**"，且**不修改上游仓库任何包**。

它解决的问题是：一个开发项目往往由多个独立 Git Repository 组成，而 DSH 原生只把会话工作目录当作唯一的可写根，Agent 跨仓库干活就得反复换会话。

这个插件的三个核心价值：

- **Agent 零学习成本**：继续使用原生 `read` / `write` / `edit` / `bash` 工具，插件不新增任何 `workspace_*` 工具，只是把"哪些目录属于当前 Workspace"这一个问题的答案变多了。
- **安全不降级**：多根授权走上游同款机制——进程内 fs fence + 内核级 runner（macOS Seatbelt / Linux bwrap / Landlock），fs 与 bash/PTY 共享同一条 scope；绝不退化为 danger-full-access 或提示词约束。
- **不装就当不存在**：以 bundle patch 替换上游 `fs-sandbox` 与 `sandbox` 两行 provider；未配置附加根时行为与未装插件逐项一致，misconfiguration 一律响亮报错，从不静默降级。

第一期（MVP）已完成并通过验收：M1 组合与空根直通、M2 多根能力与方言 grant、M3 根注册表 / `/workspace-folders` 命令 / Workspace Folders 面板 / 跨仓库旅程 e2e。证据见各[已完成计划](./docs/plans/README.md)。

## 快速开始

已有 DSH 运行时（web / Electron 桌面 / headless 均可）时，最短路径是两步——插件已发布到 [npm](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace)：

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
dsh --profile web
```

其他安装来源（GitHub 仓库 / 本地源码）与源码方式运行 DSH 的命令差异，见[安装](#安装)。

启动后侧栏底部出现 **Folders**（`🗂`）动作，或直接在会话里：

```text
/workspace-folders add ~/code/another-repo
```

之后 Agent 即可在该目录读写、跑 bash——与本会话的工作目录同权。

## 环境要求

- **使用已发布的插件**：只需要一个可用的 DSH 运行时（`0.1.5-rc.2` 及兼容版本），`dsh plugin` 会把包装进对应 profile，无需本地 Node 工具链
- **从源码构建 / 参与**：**Node.js** `^22.19.0 || >=24`（仓库 `engines` 钉住）、**Git**、**pnpm 11**（`packageManager` 钉 `pnpm@11.25.0`，建议经 corepack 启用）
- **DSH 运行时 `0.1.5-rc.2`**（开发依赖精确 pin；升级流程见[开发工作流](./docs/development/plugin-development-workflow.md)）
- **平台支持**：macOS（Seatbelt）与 Linux（bwrap 或 Landlock）内核级多根全量；Windows 仅 `fs` 写路径覆盖附加根（受限 bash/PTY 不含，见[已知限制](#已知限制第一期)）
- 运行冒烟测试**不需要模型凭据**：e2e 的模型轮次由内联的脚本化 OpenAI 兼容端点提供

## 安装

`dsh plugin` 支持四种安装来源。以下均以 web profile 为例；桌面端（Electron）把 `--profile web` 换成 `--profile desktop`，安装方式同源。

| 来源 | 命令 | 说明 |
| --- | --- | --- |
| npm 注册表（推荐） | `dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace` | 预构建产物，即装即用，无需构建授权 |
| tarball | `dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-<version>.tgz` | 预构建离线包，无需构建授权 |
| 本地路径 | `dsh plugin --profile web add /path/to/package/dsh-plugin-multi-root-workspace` | pnpm `link:` 链接本地 checkout，适合开发调试 |
| GitHub / git | `dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace` | 拉源码由 `prepare` 现场构建；首次需授权 `allowBuilds`，建议锁定 tag |

从 GitHub / git 方式安装时的 `allowBuilds` 授权，请视为**允许该包的代码在安装时于你的机器上执行**（且不在 agent 运行的任何沙箱之内）——这是 pnpm ≥10 对依赖生命周期脚本的统一要求，npm 与 tarball 方式装的是构建好的 `lib/`，无此步骤。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add @dsh-electron/dsh-plugin-multi-root-workspace
```

安装的是预构建产物，即装即用，无需任何构建授权。

### 从 tarball 安装

```sh
pnpm pack @dsh-electron/dsh-plugin-multi-root-workspace
# 或从 GitHub Release 资产下载，例如：
# https://github.com/cherrchen/dsh-plugin-multi-root-workspace/releases/download/v0.1.0/dsh-electron-dsh-plugin-multi-root-workspace-0.1.0.tgz
dsh plugin --profile web add ./dsh-electron-dsh-plugin-multi-root-workspace-0.1.0.tgz
```

同样是预构建产物，无需构建授权，适合内网或离线环境交付。

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace
```

pnpm ≥10 下首次 `add` 会失败：git 安装拉取的是**源码而非构建产物**，包内自包含的 `prepare` 脚本要现场构建（直接转译 `src/`，不做类型检查）。按 `dsh` 的提示把 pnpm 打印的包键写入该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  '@dsh-electron/dsh-plugin-multi-root-workspace': true
```

然后重新执行 `add` 即可。建议锁定 tag（如 `#v0.1.0`），让后续推送无法悄悄改变实际运行的内容：

```sh
dsh plugin --profile web add github:cherrchen/dsh-plugin-multi-root-workspace#v0.1.0
```

### 从本地源码安装（开发调试）

```sh
git clone https://github.com/cherrchen/dsh-plugin-multi-root-workspace.git
cd dsh-plugin-multi-root-workspace
export CI=true    # 无 TTY 时 pnpm 的依赖自检会中止，见开发工作流 §8
pnpm install
pnpm build        # 生成 lib/（未纳入 Git），制品测试与安装都依赖它
dsh plugin --profile web add "$PWD"
```

> **提示**：如果你的 DSH 是 clone 源码方式使用（而非 `npm install -g @deepseek-ai/deepseek-harness`），`dsh` 不在全局 PATH 里，请把上述命令中的 `dsh` 换成 `pnpm dsh`——例如 `pnpm dsh plugin --profile web add ...`、`pnpm dsh --profile web`。

## 运行方法

开发自检（每步的预期结果）：

```sh
pnpm lint && pnpm typecheck   # 预期：0 警告 0 错误；两个 tsconfig 全部通过
pnpm test                     # 预期：全部通过；本机没有的内核 runner 用例会显式 skip 并打印原因
pnpm kernel:probe             # 预期：报告本机可用的内核 runner（seatbelt / bwrap / landlock）
pnpm smoke                    # 预期：compose 34/34、behavior 99/99、journey 28/28
pnpm docs:check               # 预期：0 errors, 0 warnings
```

安装进 DSH 运行时并验证组合：

```sh
dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config
```

预期：组合里**仅** `fs-sandbox` 与 `sandbox` 两行被替换为插件的 `multi-root-fs` / `multi-root-sandbox`，并插入 scope / registry / command 三行；`bash-sandbox` 保持上游（bash 与 PTY 经 `ctx.sandbox` 取根）。启动 `dsh --profile web` 后，侧栏底部出现 Folders 动作。

## 使用方法

**命令**（文本入口，headless 下同样可用）：

```text
/workspace-folders                       # 列出主根与附加根
/workspace-folders add <绝对路径>         # 无参数时打开系统目录选择器
/workspace-folders alias 1 支付           # 给第 1 个附加根起别名
/workspace-folders remove 1              # 按序号或路径移除
/workspace-folders reveal 1              # 在文件管理器中显示
```

`add` 后执行 `list` 的预期输出：

```text
Workspace root (primary; access follows the current sandbox mode): /home/me/monorepo
  1 /home/me/payments-service [支付]
  2 /home/me/website
Writable additional roots: 2 of 2.
```

**面板**（Web GUI）：侧栏底部的 **Folders** 对话框列出主根与附加根，支持添加（走组合好的目录选择器或手输路径）、移除、别名、复制路径、在文件管理器中显示与上下移排序；文案中英双语跟随界面语言。根目录的状态会如实显示：`missing`（暂时不存在）、`redirected`（被替换成指向别处的符号链接）的根**保留登记但暂不授予**，目录恢复后 `list` 或面板刷新即自动重新授予，无需重启。

**模型侧**：附加根拓扑经 `systemPrompt.context` 快照随每次请求告知模型（同 workspace、cwd 不变），无需新增内省工具。授权规则（canonical 化、`recordedPath` 防符号链接转移、冲突拒绝）的完整语义见[架构文档](./docs/architecture/multi-root-workspace.md)。

## 项目结构

```text
src/
  roots.ts        纯规则层：canonical 化、冲突校验、登记状态分类（available/missing/redirected/invalid）
  registry.ts     根注册表：dsh-storage-domain 持久化，同一主根的变更在一条队列里串行
  scope.ts        ctx.multiRootScope：唯一的授权源，兼发模型可见的拓扑快照
  fs.ts           多根文件系统 provider（进程内 fence，子类自上游 LocalFileSystem）
  sandbox.ts      多根内核沙箱 provider（子类自上游 LocalSandboxProvider）
  dialects.ts     Seatbelt / bwrap / Landlock profile 的识别与附加 grant 拼装（不认识即响亮报错）
  containment.ts  路径包含判定（词法快速路径 + dev/ino 别名回退）
  command.ts      /workspace-folders 命令与面板 RPC 的 host 半部
  contract.ts     面板线协议（zod 双端校验，可内联进浏览器 bundle）
  client/         浏览器半部：侧栏动作、对话框、双语词典
tests/            差分 parity、方言真实执行矩阵、契约往返、组件与 locale 门禁
scripts/          冒烟（compose / behavior / journey）与文档、内核 runner 检查
docs/             需求、架构、决策记录（ADR）、计划、开发工作流
```

## 贡献指南

欢迎 Issue 与 PR：

1. 先读 [`AGENTS.md`](./AGENTS.md)（仓库级规则）与[开发工作流](./docs/development/plugin-development-workflow.md)（环境、命令、双运行时矩阵、升级流程）。
2. 从 `main` 拉分支；提交信息遵循 conventional commits（`feat` / `fix` / `perf` / `refactor` + scope），参见现有历史。
3. PR 前本地必须全部通过：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm docs:check`、`pnpm smoke`（CI 按同序执行，先 build 后 test）。
4. 影响行为的变更需同批更新 `docs/` 下的对应文档；README 保持中英双语同步；有取舍的工程决策请新增 ADR。
5. 硬约束：**不修改上游仓库（deepseek-harness）任何包**；插件只做 out-of-tree 扩展。

## 已知限制（第一期）

- Windows 的内核级多根未实现：`fs` 写路径覆盖附加根，但受限 bash/PTY 写不进去（非空 scope 时插件输出一次显式告警）；详见[需求文档](./docs/requirements/multi-root-workspace.md)第一期范围。
- 附加根与主根同权（无 per-root read-only）；附加根不能作为 bash/PTY 的默认工作目录（session cwd 语义不变）。
- `workspace-files`（Client 文件树）仍只看主根。
- 命令的输出文案为英文（host 侧没有活动语言信息），面板文案中英双语跟随界面语言。
- Workspace Folders 面板是「侧栏底部动作 + 对话框」，不是独立全屏面板：0.1.5 才有的 `sidebar.panellist`/`main` 插槽在已安装的 0.1.2 桌面运行时上不存在，这样做可以同时兼容两个运行时。

## 文档

项目长期文档位于 [`docs/`](./docs/README.md)：

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
