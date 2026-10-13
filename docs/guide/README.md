# 用户指南

English: [README.en.md](./README.en.md)

面向使用者的指南：README 只写"怎么做"，这里补上"为什么"与"具体语义"，遇到非默认情形时查阅。

## 目录

- [支持矩阵为什么是精确版本清单](#支持矩阵为什么是精确版本清单)
- [allowBuilds 那一步在授权什么](#allowbuilds-那一步在授权什么)
- [各安装来源的差异](#各安装来源的差异)
- [`/workspace-folders` 命令的完整语义](#workspace-folders-命令的完整语义)
- [访问级别、数量上限与 per-tool 封顶](#访问级别数量上限与-per-tool-封顶)
- [组合里实际发生了什么](#组合里实际发生了什么)
- [模型侧与面板侧的行为](#模型侧与面板侧的行为)

## 支持矩阵为什么是精确版本清单

本插件替换的是 `ctx.fs` 与 `ctx.sandbox`——安全边界本身——而它识别内核沙箱方言靠的是对具体上游版本实测出来的 argv 形状。所以 `peerDependencies` 只列真正跑过全套验证的版本，启动时也会再查一遍：宿主的版本不在清单上，或者若干个 `@deepseek-ai/dsh-*` 混装了不同版本，那么 fs / sandbox / registry / instructions / lsp / workspace-files 六行**不启动**，组合退化成"没装这个插件"，并打印一条说明。诊断办法见[故障排查](../troubleshooting/unsupported-dsh-release.md)，理由见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。

## allowBuilds 那一步在授权什么

本插件带一个需要构建的原生依赖 `koffi`（Windows 上 Registry Authority 用的 FFI 封装；其他平台装了不用），而 pnpm ≥10 默认不运行任何依赖的生命周期脚本。所以第一次 `dsh plugin add` 会以 `[ERR_PNPM_IGNORED_BUILDS]` 失败，并把待决项写进该 profile 的 `pnpm-workspace.yaml`。把 `koffi: true` 写进 `allowBuilds` 意味着**允许该依赖的安装脚本在你的机器上执行**（不在 agent 运行的任何沙箱之内）——`koffi` 的脚本只做本地预编译。

两个实测过的坑（DSH `0.2.1-alpha.2`，tarball 来源）：profile 的 `pnpm-workspace.yaml` 可能**没有** `set this to true or false` 占位标记（直接补 `allowBuilds` 即可）；恢复后的 `add` 退出 0 也可能没把插件激活进 `dsh.profile.bundles`——检查该 profile 的 `package.json`，缺的话做一次 `remove` + `add`。诊断步骤见[故障排查](../troubleshooting/install-stops-at-build-approval.md)。

## 各安装来源的差异

- **npm / tarball**：预构建产物，插件本身不参与编译；首次安装需要 `allowBuilds`。
- **GitHub**：装的是源码，`add` 时由包内 `prepare` 脚本自动构建（直接转译 `src/`，不做类型检查），因此 `allowBuilds` 需要覆盖本包自身和 `koffi` 两项；不带 ref 会跟随 `main` 分支的最新提交，写 `#v0.1.6` 这样的版本 ref 锁住内容，`#semver:*` 这类 semver 范围则始终解析到最新 tag。
- **从源码安装**：pnpm `link:` 链接本地 checkout，依赖在本仓库已装好，无需 `allowBuilds`；需要先 `pnpm build` 生成 `lib/`（未纳入 Git）。

用源码仓库跑 DSH 时 `dsh` 不在 PATH 里，把命令里的 `dsh` 换成 `pnpm dsh`。

## `/workspace-folders` 命令的完整语义

命令是文本入口，headless 组合下同样可用；子命令为 `list` / `add` / `remove` / `alias` / `access` / `reveal` / `help`，`/workspace-folders` 不带参数等同 `list`。

- `add` 不带路径时打开系统目录选择器（组合了目录选择器的 profile 才有），也可以 `add --read-only` 只给 flag 不给路径。
- 路径可以带引号，`~` 会展开为家目录；登记前会先 canonical 化——与已有根重复、嵌套在已有根内部、或就是主根本身的路径会被拒绝。
- `remove` / `access` / `alias` / `reveal` 的参数接受 `序号|路径`（序号即 `list` 输出的编号）。
- `alias` 不带别名参数会清除已有别名。
- `access` 支持 `inherit` / `read-only` / `read-write`；扩权变更要求该根此刻可用，具体方向见 [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)。
- `list` 如实显示每根状态：`missing`（暂时不存在）、`redirected`（被替换成指向别处的符号链接）的根**保留登记但暂不授予**；目录恢复后执行一次 `list` 或刷新面板即自动重新授予，无需重启。
- 命令的输出文案为英文（host 侧没有活动语言信息）。

## 访问级别、数量上限与 per-tool 封顶

面板同时显示登记策略与宿主派生的当前有效权限，并注明工具写入封顶；继承与固定读写之间的切换均需确认。目录失效只撤销授权，不解除仍登记的只读边界。

B9 开发分支中，新根默认 `inherit`（继承会话模式）；`add --inherit|--read-only|--read-write` 或面板可显式选三档。显式只读保持完整成员资格，但 Full-access 也不得写；固定读写在全局只读会话仍可写该根。旧可写记录升级为 inherit，重新登记保留原策略。权限与迁移合同见 [ADR-0017](../decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)；已启动进程保留启动快照，变化只约束之后的调用与新进程。发布包是否包含 B9 见[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#b9附加根三态权限与跨-sandboxmode-执行一致性2026-10-13)。

Windows Full-access 的局部拒写独立 runner 通过管理员安装的 broker 赋予暂停子进程普通 deny-only 组 token，读回验证后恢复执行；缺少可信 broker 时拒绝启动。Windows ACL 继续报告 partial；其 token 与 ACL 合同见 [ADR-0020](../decisions/ADR-0020-windows-normal-deny-groups.md)。无法表达的后端组合拒绝启动，不退回裸进程；具体后端限制见 ADR-0017。

每个主根的附加根数量有上限（默认 16，经注册表行配置 `maxAdditionalRoots` 可调至 64）；超限的新增被拒绝，历史超限记录照常授予（[ADR-0014](../decisions/ADR-0014-root-limit-and-provider-conflict.md)）。

宿主还可以在 `multi-root-scope` 行配置 `toolAccess: { <工具名>: 'read-only' }`，让某个工具永远不能写任何附加根（例如 `{ bash: 'read-only' }`——bash 仍可写主根）；非法配置 fail closed。

## 组合里实际发生了什么

`dsh --profile web --dump-config` 的输出是按 bundle 分组的 YAML 行数组（每行 `id` / `name` / 可选 `disabled` / `config`），`# == <bundle>` 注释行标记来源、`patched by` 标记被 patch。装入本插件后的差异是：

- 上游 `fs-sandbox` 与 `sandbox` 两行打上 `disabled: true`；
- 末尾追加 `# == @dsh-electron/dsh-plugin-multi-root-workspace` 段的全部 `multi-root-*` 行（compat 门禁、fs、sandbox、providers 冲突检测、scope、registry、instructions、lsp、workspace-files、process-fence、command、client 载体行）。

`bash-sandbox` 保持上游：受限模式经 `ctx.sandbox` 取根；Full-access bypass 由 `multi-root-process-fence` 包装 shell / PTC / PTY 的公开入口，按同一 scope 应用只读限制。插件只做 out-of-tree 扩展，不修改上游任何包。

## 模型侧与面板侧的行为

- 附加根拓扑经 `systemPrompt.context` 贡献注入系统提示词（授权变化时重渲），同一 Session 原始项目不变、切换执行目录不改变授权；无需新增内省工具。
- 附加根自身的 `AGENTS.md` / `CLAUDE.md` 也会进入模型上下文：根目录顶层的在会话第一步之前注入，子目录的在本会话成功触碰过该目录之后注入（上游的原生发现从会话 cwd 向上走，永远到不了附加根）。
- 面板侧：侧栏底部 **Folders** 动作打开对话框；Files 页签的根选择器可以浏览附加根（选中时树区由原生的复刻视图接管，切回主根恢复原生）。面板文案中英双语跟随界面语言。

B9 Windows Full-access 局部只读需要管理员安装随包提供的特权 broker（[安装与安全边界](../decisions/ADR-0020-windows-normal-deny-groups.md#安装与卸载)）；插件不会自动提权。Linux 同组合需要可执行的 bubblewrap，即使普通受限模式选择的是 Landlock。依赖缺失会报告 runner 不可用，不能作为允许裸启动的理由。
