# Socket / CVE 依赖告警与升级边界

核对日期：2026-10-30。本文记录已核实的依赖来源、修复版本与尚待上游解决的约束；验证进度和发布状态只记在[路线图账本](../plans/active/2026-09-12-multi-root-workspace.md)。

## 症状与核对范围

[Socket 的 0.1.11 依赖告警](https://socket.dev/npm/package/@dsh-electron/dsh-plugin-multi-root-workspace/alerts/0.1.11?tab=dependencies) 中，CVE 包括 5 个 high 实例和 4 个 medium 实例；high 涉及 Zod 和 Undici。Socket 同时列出 shell、网络、文件系统、install script、动态加载等行为标记。这些标记用于审查能力，不能等同于已确认恶意代码，也不能代替 CVE 的版本检查；本插件的原生锁、鉴权、进程围栏本身就需要部分此类能力。

在实际安装树分别运行生产审计和完整审计。`--prod` 包含被安装为生产依赖的 Host peers 及其传递依赖，并不意味着所有条目都由插件直接声明：

```bash
pnpm audit --prod --json
pnpm audit --json
pnpm why --prod zod
pnpm why --prod undici
```

[审计前后摘要](../reference/dependency-security-audit-2026-10-30.json)保留命令、依赖文件哈希、公告、版本及示例引入链。完整开发树还包含工具链、测试与额外 Host 服务，不能将完整审计的全部条目都称为插件发布包直接依赖，也不能忽略它们在相应服务启用时的影响。审计通过与否只说明当时数据库覆盖的已知告警，不是无漏洞证明。

## 已核实的 CVE 与依赖来源

| 来源 | 告警 / 修复下限 | 当前处理 |
| --- | --- | --- |
| 插件直接依赖 `zod` | [GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，high / CVSS 8.2；修复下限 `4.6.6` | manifest 下限从 `^4.6.2` 提升为 `^4.6.7`，lockfile 和插件实际解析更新至 `4.6.7` |
| DSH 的精确 `zod@4.4.3` 依赖，包括 `dsh-storage-domain` | 同一 Zod CVE | 仍受影响；插件自身升级不替换这些副本 |
| `dsh-permission-presets → dsh-shell → dsh-subprocess → dsh-http-proxy → undici@8.11.2` | 下表 8 项；该 8.x 版本的修复下限均为 `8.12.2` | 仍受影响；`dsh-http-proxy` 精确 pin，普通重装或锁文件更新不能跨越 |

Undici 告警按审计严重性列出，影响条件以维护者公告为准，不把存在易受影响的版本直接等同于本插件已被成功利用：

| 严重性 | 公告 | 问题 |
| --- | --- | --- |
| high | [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | content-coding 错误导致未捕获异常 / 进程崩溃 |
| high | [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) | 跨源 redirect 的缓存污染和跨用户泄露 |
| high | [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | Agent 丢失 TLS 选项，可能绕过证书校验 |
| high | [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | TLS 1.2 renegotiation 拒绝服务 |
| moderate | [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) | EventSource parser 无界内存 |
| moderate | [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) | SRI 算法 token 大小写导致校验绕过 |
| moderate | [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) | WebSocket 自动 PONG 无界缓冲 |
| moderate | [GHSA-55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6) | decompress interceptor 未捕获异常 |

npm 元数据核对：当前开发基线 `0.2.2-alpha.2` 和当时最新 `0.2.1-rc.5` 的 `dsh-storage-domain` 均精确依赖 `zod: 4.4.3`，`dsh-http-proxy` 均精确依赖 `undici: 8.11.2`。因此仅提升到 rc.5 不解决这两组告警；本变更没有据此扩充 DSH 支持矩阵。

## 当前锁文件中的修复与剩余项

在父包原有 semver 范围内更新 Vitest `4.1.12`、Vite `8.3.5`、Undici 7.x `7.30.1`、Fast URI `3.1.9`、Source Map JS `1.2.2`、compression `1.8.2` 及相关传递依赖。Google GenAI 原来自动带入的可选 MCP SDK peer 以开发依赖显式保留并升级到 `1.32.2`，其 `mcpToTool` 仍可加载；没有通过移除这条可选能力减少告警。这是当前开发/Host 基线的安全升级，不会强制升级消费插件的 Host。

定向刷新锁文件时曾临时约束已核实兼容的补丁版本，随后移除约束并重新解析；最终 manifest、workspace、lockfile **不保留 overrides 或 patchedDependencies**，冻结安装通过。不会用覆盖上游精确 pin 的办法把普通安装声明为修复版。

除生产审计里的 Zod / Undici 外，完整树还剩两项 moderate：

| 引入者的精确依赖 | 公告 / 修复下限 | 剩余约束 |
| --- | --- | --- |
| `@deepseek-ai/libreoffice-kit@0.1.5 → fflate@0.8.2` | [GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98) / `0.8.3` | 需要父包解除精确 pin；仅更新其他调用方的 fflate 不替换这个副本 |
| `dsh-mcp-client → @modelcontextprotocol/client@2.2.0` | [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) / `2.3.0` | 当前基线及 `0.2.1-rc.5` 均精确 pin；1.x SDK 的升级不替换 2.x client |

## 修复边界与后续顺序

1. **先修插件直接依赖的下限。** 本次 Zod 补丁可进入下一发布包；只修改 lockfile 不够，因为消费者安装依赖时不使用本仓库的 lockfile。打包检查还须确认 tarball 内 manifest 的下限。
2. **保留上游 schema 的解析边界。** `src/compat/storage-zod.ts` 继续从 `dsh-storage-domain` 自己的位置解析 Zod；不能把插件新版 schema 强塞给仍使用旧版 Zod 的 domain。相关兼容合同见 [ADR-0009](../decisions/ADR-0009-dsh-compat-contract.md)。
3. **上游解除精确 pin 后，再验证对应 DSH 版本。** 修复需要 Host 实际使用的本文所涉 Zod 4 副本至少 `4.6.6`，Undici 8.x 至少 `8.12.2`；如树中保留 7.x，应按公告升级到该主线的修复版 `7.30.1`，不要直接跨主版本替换。随后执行精确版本矩阵、原生权限/沙箱、真实 IPC、Skills、打包安装和生产审计，才可扩大支持声明。
4. **Host 根项目 override 是独立的兼容候选。** 本仓库的 pnpm override、npm override 或 patchedDependencies 不会自动传递给消费此插件的 Host。若操作者决定覆盖上游精确依赖，必须在实际 Host 根项目配置，并独立完成兼容和安全验证；本文没有把这种组合声明为已支持或已修复。不要通过删除 Host peer、关闭沙箱或屏蔽审计来消除显示的告警。
5. **完整开发/Host 树独立验收。** 原树还发现 `proxy-addr <2.0.8` 的 [critical 告警](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)，已随当前锁定的 MCP SDK / 传递依赖升级消除。本文所列剩余两项 moderate 仍需父包更新。实际 Host 必须检查自己的安装树，不能使用本仓库开发审计的结果代替生产组合验收。

已发布的 `0.1.11` 及其 Socket 页面不会因开发分支变更而成为修复版。完成插件补丁、上游 Host 依赖修复、兼容验证与正式发布之前，不能对外宣称 CVE 已全部解决。
