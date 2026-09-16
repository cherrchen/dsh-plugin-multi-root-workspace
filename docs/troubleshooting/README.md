# 故障排查（Troubleshooting）

English: [README.en.md](./README.en.md)

## 这里存放什么

已经验证、具有重复价值的问题处理经验，每条记录通常包括：

- Symptoms（症状）；
- Root Cause（根本原因）；
- Diagnostics（诊断方法）；
- Verified Solution（已验证的解决方案）。

## 不应该存放什么

不要把所有一次性报错都记录进来。

只有预期会复发、且排查成本较高的问题才值得记录。

## 当前状态

- [client bundle 不进 web 启动图：bundle patch 只挂子路径行](./client-bundle-not-in-boot-graph.md) — footer 槽位注册静默失效的根因与修复。
- [面板报"无法连接到 dsh 主进程"（HTTP 405）](./panel-channel-http-405.md) — 通道注册被 cordis 服务解析静默吞掉的根因与修复。
- [根目录登记被另一个 DSH 进程占用](./registry-owned-by-another-process.md) — 两进程共用 `$DSH_HOME` 时的 fail-closed lease 与接管方式。
- [DSH 版本不在支持矩阵上](./unsupported-dsh-release.md) — `unsupported` / `mixed` / `incomplete` 三种判定、provider 不启动的原因，以及人工提升新版本的流程。
- [安装停在构建授权](./install-stops-at-build-approval.md) — 首次 `dsh plugin add` 因 `koffi` 的构建脚本被 pnpm 拦下而失败，以及那一次 `allowBuilds` 表态怎么回。

## 推荐命名

使用小写中划线命名，例如：

```text
<symptom-or-topic>.md
```
