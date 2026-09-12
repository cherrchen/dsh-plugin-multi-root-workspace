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

## 推荐命名

使用小写中划线命名，例如：

```text
<symptom-or-topic>.md
```
