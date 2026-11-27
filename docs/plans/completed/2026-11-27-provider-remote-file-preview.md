# 按 Provider 分派的远端文件预览

> 状态：**P1–P8 完成，PASS WITH LIMITATIONS；已随 PR [#81](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/pull/81)（`4ea9312`）合入 `main`，并随 `v0.1.25-beta.2` 发版**（接受与否由维护者决定）。基线：`c7707f8f2e80aa75dd30c013af9ada37db505db4`；承接 [ADR-0052](../../decisions/ADR-0052-provider-file-browsing.md) / PR #80。

## 交付范围

[ADR-0053](../../decisions/ADR-0053-provider-remote-file-preview.md) 采用插件自有 Viewer 复用 DSH 标签页和 `FilesPane`。协议、授权、生命周期及非目标以[远端预览架构](../../architecture/remote-file-preview.md)为准；使用方式见 [SSH 使用指南](../../guide/user/ssh-remote-environments.md#预览远端文件可选)。

## 最终验收报告

### P7：实际 SSH、GUI、版本与预算

以 Node `24.22.3` 在 macOS 上串行运行 `pnpm build` 和 `DSH_LIVE_PREVIEW=1 node scripts/live-remote-preview-loopback.mjs`。脚本将同一生产 tarball 装入隔离 DSH Web profile，使用临时密钥和回环 OpenSSH；文件字节经真实 SFTP 与 Connection 二进制 RPC，不使用 mock。注册、撤注册和重授由隔离 Host 的真实面板 RPC 驱动，浏览、打开、切换标签、页内导航与刷新由 Chromium 操作。旧宿主通过 `DSH_CLI` 指向各自安装树，每个版本独立运行；不要并行打包，`pnpm pack` 会通过 `prepare` 重建 `lib/`。

| 实际 DSH 版本 | 真实 Web / Chromium + SSH 结果 |
| --- | --- |
| `0.2.3-alpha.2` | **20/20 PASS**；生产预览和 Folder Navigator 正向验收 |
| `0.2.2-rc.1` | **4/4 PASS**；可列目录，文件行惰性，不发放预览提示 |
| `0.2.2-rc.2` | **4/4 PASS**；同上 |
| `0.2.2-rc.5` | **4/4 PASS**；同上 |
| `0.2.2-rc.3` / `rc.4` 与其他版本 | **NOT RUN**（本任务未跑生产 GUI）；预览由版本门关闭，既有插件支持声明不变 |

四条车道使用相同的打包产物，DSH 核心与相关 UI 包的实际解析版本各自一致。脚本将本机日志和截图写入 Git 忽略的 `.dsh-smoke/remote-preview/`。

| 场景 | 证据与结论 |
| --- | --- |
| Files 行与 Viewer | **PASS**：选择已登记根、展开目录、点击文件、以宿主文档预览对齐的只读界面显示真实内容；刷新读取修改后的字节；主根与本地附加根仍打开原生预览。 |
| Markdown 与导航 | **PASS**：渲染安全标题，标记、图片语法不生成活动节点；Folder 按宿主 Navigator 形态定位当前文件、同 pane 替换且不增加标签页、保留另一目录的展开；深色宿主仍能呈现内容。 |
| 授权和资源隔离 | **PASS**：`read` + `directoryListing` 不授予内容；同相对路径的不同 SSH 环境只显示各自字节；关闭标签页清内容；撤注册后内容与刷新入口消失；重新授权不复活旧 Viewer；浏览器重载的旧地址明确过期。 |
| 读取边界 | **PASS**：2,040,000 字节文本的渲染内容与源文件 SHA-256 一致；2 MiB + 1 字节拒绝，且不残留上一文件。 |
| 预算与故障补证 | **PASS（测试级）**：独立的读取池、待清理任务持位、撤权发生于读取/关闭窗口时不发布字节、迟到应答围栏、客户端资源/视图/读取/共享租约上限；详见同目录源码测试 `remote-files-service` 与 `client-remote-file-preview`。 |
| 真实环境扩展 | **NOT RUN**：生产 WAN、Helper-backed 预览完整 GUI、托管密钥注册 GUI、Desktop/Linux/Windows GUI、多客户端压力与内存长跑、真实会话切出/返回、动态卸载、撤权恰落在读途中的 GUI、滚动与窄窗/浮窗逐项验证。 |

### P8：独立审查与最终门禁

回归测试覆盖了资源 pin 晚于 Viewer 挂载、隐藏标签页清除内容，以及裁剪版 Host 缺少预览服务时不影响已有面板。

| 门禁 | 结果 |
| --- | --- |
| `pnpm verify:all`（含 lint、typecheck、build、许可证、内核检查） | **PASS**；lint 0 errors，2 条既有 `require-yield` warnings；macOS Seatbelt 实跑，bwrap/Landlock 不适用本机。 |
| `pnpm test`（全量门禁内） | **179 文件通过 / 9 跳过；2965 用例通过 / 138 跳过；0 失败**。 |
| 组合 / 行为 / 旅程 smoke | **58/58、137/137、98/98 PASS**。 |
| `pack:check` / `smoke:packed` / Auto Review | **PASS**：344 个 tarball 成员校验通过；packed 行为 136/136；fork 校验与 real Web/headless（工作树与 tarball）通过。 |
| `pnpm compat:check`、`pnpm docs:check`、`git diff --check` | **PASS**；兼容 allowlist/peer/pin/安装树一致，文档无警告或错误，diff 无空白错误。 |
| `DSH_MULTI_ROOT_SSH_LOOPBACK=1 pnpm exec vitest run tests/ssh-loopback.e2e.ts` | **3/3 PASS**；包含 SFTP v3 列举、真实读取原语、服务层读真实字节。 |

### 退出判定

| 项 | 判定 |
| --- | --- |
| Implementation Status | **PASS WITH LIMITATIONS** |
| Production Readiness | **RELEASED IN `v0.1.25-beta.2`**（跨平台与真实安装由 tag 触发的 `release.yml` 判定） |
| Selected Architecture | Architecture D — Plugin-owned Viewer |
| Native Viewer Fork / Upstream Modifications | **NO / NO** |
| Remote File Preview / Remote Folder Navigator | **SUPPORTED / SUPPORTED**，限下述已实测组合 |
| Supported File Types | UTF-8 文本、源码、配置、日志、无扩展名与安全 Markdown（超 Markdown 预算显示原文）；不支持位图、PDF/Office、其他二进制和主动内容渲染。 |
| Supported / Unsupported Host Versions | 仅 `0.2.3-alpha.2` 签发预览能力；其他版本不支持预览，既有插件兼容声明未改变。 |
| Supported Transport / Custody Modes | 真机验收：个人模式 + SFTP 直连、现有 SSH config 凭据；Helper 路径仅在独立 SFTP 路径授权下可进入实现，生产全链路未验收；team、broker、非 SFTP 不在本次预览承诺内。 |
| Authorization Model / Content Transport | 独立默认关闭的 `filePreview:'stable-path'`，Host 逐次校验并在通道释放后最终复核；单个既有 Connection 二进制附件，不经资源流、不落盘。 |
| Final Test Results | 见 P7 / P8 两表。 |
| Unresolved Critical / High Issues | **无已知未关闭项**；上述环境缺口不记为已验证。 |
| Other Known Limitations | 旧标签页重载不会恢复内容；SFTP v3 无 inode/fd-bound/ABA 防护，部署必须满足稳定路径断言；2 MiB 不截断。 |
| Release Blockers | 所述验收组合无已知代码阻塞；扩大宿主、平台、Helper 或托管凭据的交付承诺前，需补对应真实环境验证。 |
| Recommended Next Action | 已随 `v0.1.25-beta.2` 发版；扩大宿主、平台、Helper 或托管凭据的交付承诺前，补齐对应的 CI 与真实环境车道。 |
