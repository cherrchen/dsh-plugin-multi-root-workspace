# 安全策略

English: [SECURITY.en.md](./SECURITY.en.md)

## 支持的版本

本插件按[精确 DSH 支持矩阵](./README.md#环境要求)发布。安全修复只进入最新发布版本；更早版本请先升级后再复现。预发布版本不单独承诺安全支持，问题请在最新稳定版验证。各版本的发布状态见 [CHANGELOG](./CHANGELOG.md)。

## 报告漏洞

请使用 GitHub 的私密漏洞报告：

https://github.com/cherrchen/dsh-plugin-multi-root-workspace/security/advisories/new

不要通过公开 Issue、PR、Discussion 或社交媒体披露未修复漏洞。若私密报告入口不可用，请通过维护者 GitHub 资料中的联系方式私下联系，并在得到确认前不要发送利用细节。

报告中请尽量包含：

- 受影响的插件版本，以及安装来源（npm / tarball / GitHub / 源码）；
- DSH 精确版本、操作系统与沙箱模式；
- 涉及的附加根数量与访问级别（inherit / read-only / read-write）；
- 漏洞影响与攻击前提（本地用户、恶意工作区、恶意插件等）；
- 最小复现步骤或 PoC；
- 相关日志（请删除凭据、令牌、私有路径）；
- 是否已公开、期望的披露时间与署名方式。

## 处理流程

- 我们会在 7 天内确认收到报告（目标，不构成 SLA）。
- 评估后会给出影响判断、修复计划或缓解建议；修复时间取决于严重性和复杂度。
- 默认在修复发布后协调披露，或报告后 90 天披露，以先到者为准；如需更早或更晚，可协商。
- 除非你要求匿名，我们会在安全公告中致谢。
- 本仓库不提供漏洞赏金。

## 范围

### 在范围内

- **附加根边界绕过**：原生 fs、bash / PTY、LSP、workspaceFiles、Skills、文档预览等路径在未授权时读取或写入附加根之外。
- **根登记与授权**：符号链接、重命名、路径规范化、受保护目录、跨主根污染、Registry 存储篡改、跨 Host lease / IPC 冒充、面板会话派生授权绕过。
- **进程围栏与未登记启动绕过**。
- **指令 / Skill 注入跨越根边界**，或把用户上下文提升为系统权限。
- **组合 / patch 在零附加根或外来 provider 下错误扩大授权**。
- **凭据或秘密**经插件日志、面板或传输泄露。
- 启用 Auto Review 或 OPS 兼容模式后，写围栏或授权检查被绕过。

### 不在范围内

- 上游 `deepseek-harness` 本身的漏洞；请报告给上游。若本插件放大了影响，请同时告知我们。
- 依赖（`zod`、`clsx`、`koffi`、DSH 包等）自身的漏洞；请报告给对应维护者，并告知我们受影响的版本。
- 需要攻击者已经控制本机用户账号、`$DSH_HOME`、profile 或已安装插件代码的问题。
- `danger-full-access` 的预期广泛写权限；只读附加根只是写限制，不是读隔离（见 [ADR-0017](./docs/decisions/ADR-0017-three-state-root-access-and-sandbox-modes.md)）。
- 已记录的已知限制与接受风险（见下）。
- 第三方插件 / bundle 自身的漏洞。
- 纯本机资源耗尽的 DoS（除非可远程触发或跨越授权边界）。
- 社会工程、物理访问、供应链攻击（除非本仓库的构建 / 发布链路可被利用）。

### 已知且接受的风险

- **根管理没有独立于 owner cookie 的可信人工确认（BYP-01）**：上游没有提供这样的确认通道；同用户进程伪造 owner cookie 后仍可能自行登记根。该风险保留，见[根授权安全修复计划](./docs/plans/completed/2026-11-05-root-authorization-security-fixes.md)。
- **Full access 按设计广泛可写**：`danger-full-access` 下只保留显式 deny 边界；不要用它处理不可信工作区。
- **只读根不是读隔离**：`--read-only` 拒绝写入，不限制读取。
- **第三方进程不受围栏保证**：插件只约束自己的工具与经其包装的启动路径；其他插件直接启动的进程不在保证内。
- **Auto Review / OPS 兼容模式是实验性、默认关闭**：开启后才提供相应保护；关闭 OPS 适配会恢复旧行为，可能允许 OPS 写入显式只读附加根。
- **多 Host 共享限同机、同用户、同锁命名空间**；跨用户 / 跨机器不提供隔离承诺。

## 安全研究约定

- 只在你拥有或获得明确授权的环境中测试。
- 不要访问、修改、删除或外传他人的数据；不要进行拒绝服务、社会工程或物理攻击。
- 给维护者合理时间修复，再公开细节。
- 善意研究不追究；请遵守适用法律。

## 相关文档

- [架构文档](./docs/architecture/README.md)
- [决策记录（ADR）](./docs/decisions/README.md)
- [已知限制](./README.md#已知限制)
- [根授权安全修复计划](./docs/plans/completed/2026-11-05-root-authorization-security-fixes.md)
