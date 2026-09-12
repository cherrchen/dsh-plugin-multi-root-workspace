# ADR-0003: 方言 grant 拼接策略（观测克隆、结构识别、失败即抛错）

## Status

Accepted

## Date

2026-09-12

## Context

[ADR-0002](./ADR-0002-upstream-coupling-policy.md) 决策 2 已定下"多根方言 grant 不调用上游 builder，改为从 `super.confine` 的输出识别并克隆 grant 模板，识别失败即抛错"。M2 实施前实测补齐了三条决定实现形态的事实：

1. **公开面只有 `confine` 与 `internals`**：`@deepseek-ai/dsh-sandbox-local` 的发布 `.d.ts` 中 `runnerArgv` / `landlockLauncher` / `seatbeltExec` / `windowsAclRunnerArgv` 全是 TS-private，子类无法类型安全地调用；只有 `confine(argv, policy)` 与测试钩子 `internals` 可用。
2. **输出结构稳定且可校验**：`confine` 返回 `[...profileArgs, '--', ...callerArgv]`，因此分隔符位置可由 `argv.length` 精确算出并逐元素验证；四种方言的 profile 段各有一到两个结构标记（`-p` / `--mode` / `--rw` / `--ro-bind`）。
3. **方言授权拼写可由观测得到**：bwrap 的 bind flag 出现在 `[flag, <policyRoot>, <policyRoot>]` 三元组里，Landlock 的 rw flag 出现在 `<policyRoot>` 前一位，Seatbelt 的 `(subpath "…")` token 就在要扩展的 allow form 内部——都不需要硬编码常量。

同时存在一个会误导实现的选择：为了得到"额外根在方言里长什么样"，可以调用 `super.confine` 并把 `policy.workspaceRoot` 换成额外根，从输出里取模板。这条路径在 darwin/Linux 上只是纯字符串构造，但在 win32 上 `confine` 会走 `materializeAclGrant`，真实创建 ACL grant 与私有临时目录——用测试用的假根去触发它有切实副作用。

## Decision

1. **结构识别**：方言由 profile 段的结构标记唯一匹配确定（seatbelt `[… , -p, <SBPL>]`、windows-acl 含 `--mode`、landlock 含 `--rw`、bwrap 含 `--ro-bind`；`runnerCommand` 配置情形按上游契约与 bwrap 同形）。命中 0 个或多个标记一律抛 `DialectUnrecognizedError`。
2. **观测克隆**：grant 的 flag 拼写与插入位置从 `super.confine` **实际产生的 argv** 中提取（bind 三元组 / rw 相邻位 / subpath allow form），不硬编码上游 flag 常量，也不为探测模板而二次调用 `super.confine`（避免 win32 的 ACL 副作用）。
3. **已授予即跳过**：先解析该方言已经授予的集合（Seatbelt 的 subpath 字面量、bwrap 的 `--tmpfs` 目标与 bind 目标、Landlock 的 `--rw` 路径），与之相等的附加根不再重复授予。这与 fs fence 的 `roots.includes` 去重对齐，并避免在 bwrap 上把真实 `/tmp` bind 到 `--tmpfs /tmp` 之上而改变上游的临时区语义。
4. **门控在 provider，不在拼接函数**：只有 `workspace-write` 且 scope 非空才拼接；`read-only` 与 `danger-full-access` 一律原样返回上游结果（bash 与 PTY 在 `danger-full-access` 下根本不调用 `confine`）。
5. **失败即抛错**：识别或克隆失败转译为 `SandboxUnavailableError`，命令不执行——绝不退化为"只授予主根"的静默执行。唯一例外是 win32 的 ACL rung：它按 workspace SID 授权、argv 里没有路径可加，第一期保持上游 wrap 并输出**一次**显式告警（已知限制，见需求文档第一期平台范围）。
6. **parity 由测试侧独立解析器裁定**：矩阵测试不复用生产解析代码，而是用独立实现从 argv 反解授予集合，再与 fs fence 的真实写判定逐项比对。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 硬编码各方言 flag 常量（`--bind` / `--rw` / `(subpath …)`） | 上游改拼写时无法发现，只会静默产出错误 profile；观测克隆顺带把"上游换了写法"变成可识别的失败 |
| 用合成 policy 调 `super.confine` 取模板 | win32 上会真实物化 ACL grant（副作用），且把一次受限调用变成两次上游调用 |
| 深导入上游 `sandbox-local/src/profiles.ts` 的 builder | 发布包不含 `src/`，安装形态必然失败（ADR-0002 §1） |
| 直接实现各方言的 profile（自带 builder） | 等于把上游单根语义重写一遍，并永久承担方言漂移；且 `writableRoots` 等共享语义会分叉 |
| 识别失败时退化为单根并在日志里警告 | 违反需求 §13「单一权限世界」：fs fence 会允许附加根而 bash 不能写，用户只能靠"写失败"发现 |
| win32 上也抛 `SandboxUnavailableError` | 会让 Windows 上所有受限 bash 直接不可用，代价远大于限制本身；需求已把 Windows 内核级多根排除在第一期之外 |

## Consequences

- 正面：插件对上游的依赖面收敛到「`confine` 的输入输出形状」这一条可验证的契约；上游改拼写会立即变成一次显式失败，而不是静默的安全语义漂移。
- 正面：parity 责任被显式承担——矩阵测试是升级门禁的一部分（改 pin 后必跑）。
- 代价：`widenProfileArgs` 依赖对 argv 形状的识别，上游若改变包装结构（例如不再用 `--` 分隔、或增加新的标记），识别会失败并要求同步插件；失败是 fail-closed，不会放行。
- 代价：Windows 上 fs 可写而 bash 不可写的不对称在第一期保留，必须由文档与一次性告警持续说明。
- 代价：`tmpdir()` 相关的授予差异（上游 bwrap/Landlock 只授予字面 `/tmp`）不由插件修正；parity 断言的语义限定为「附加根集合与模式」，`/tmp` 行只对本机原生方言比较。

## Related Documents

- [ADR-0001：只替换两个 provider 行](./ADR-0001-provider-replacement-scope.md)
- [ADR-0002：上游耦合策略](./ADR-0002-upstream-coupling-policy.md)
- [架构设计：Multi-root Workspace](../architecture/multi-root-workspace.md)
- [上游调研 §10：M2 期实测的方言形状](../reference/multi-root-workspace-research.md)
- [M2 开发计划](../plans/completed/2026-09-12-m2-additional-roots-and-dialect-grants.md)
