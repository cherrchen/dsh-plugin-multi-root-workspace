# SSH 分支完整审查（2026-11-15）

## 范围与结论

审查分支 `feat/ssh-workspace`，基线 `50fb77b67e58f96d8640a83de5def32b99294c50`，被审树 `b4027dc056526959f20157c0271e81a16ed8badf`（与审查期间的 `5796572` 内容相同）。相对 merge-base 共 189 个文件，新增 27725 行、删除 178 行。覆盖远端控制面、两次准入、SSH/broker/SFTP、传输、个人凭据管理、客户端、兼容门禁、打包与文档；现有 main 后续发布不作为本分支新增问题。

**审查时结论：需要修改。** 确认 10 项问题（5 项 P1、5 项 P2），均以针对性用例复现。原有测试全部通过不代表下列路径已被覆盖。未发现足够证据支持 P0。已接受的 personal 凭据隔离风险、默认关闭的实验状态与既有 BYP-01 残余风险不重复记为本次缺陷。

下列描述记录修复前的事实；修复状态与最终验证见文末，避免把历史审查与当前实现混淆。

## 确认问题

### R1 · P1 · SFTP 未强制主机密钥校验与禁用 agent 转发

位置：[sftp.ts](../../src/remote/sftp.ts) 的 `SftpClient.connect`（审查时 148–152 行）。personal 放宽配置预检的前提是上游 SSH 启动器会强制安全参数，但 SFTP 独立启动 `ssh`，仅指定 BatchMode 与禁用复用。因此用户别名中的 `StrictHostKeyChecking no` / `ForwardAgent yes` 原样生效，文件通道可能接受更换后的服务器密钥并转发 agent。

复现：实际 `ssh -G` 解析客户端参数后得到 `stricthostkeychecking false`、`forwardagent yes`。应在此独立通道强制主机校验、禁用转发，并验证配置不能覆盖它们。

### R2 · P1 · SFTP OPEN 的权限属性编码错误

位置：[sftp.ts](../../src/remote/sftp.ts) 的 `open`（265 行）。将 `0600` 写进 ATTRS flags，而没有发送 permissions 字段；OpenSSH 以默认模式创建，umask 022 时结果为 0644。传输暂存文件可能向拥有目录遍历权的其他用户暴露内容。

复现：真实本机 OpenSSH `sftp-server -u 022` 创建文件，请求 0600、实得 0644。应发送 flags=4 + permissions；无权限参数时发送 flags=0。

### R3 · P1 · broker 后端断线被报告为进程退出

位置：[broker/client.ts](../../src/remote/broker/client.ts) 的 exit 分发（178–190 行）。server 将 helper 的 `done` 拒绝编码为 `BROKER-LOST`，client 却把它转成 signal=null 的 exit。broker IPC 仍存活时，上层收到 `exited/unconfirmed`，丢失 `unknown` 与 reconcileId，不能诚实表达远端执行结果未知。

复现：真实本地 broker IPC 配合可控 helper 断线，得到 `exited`。应在即时和提前到达事件两条路径均调用 lost，而非 exit。

### R4 · P1 · 撤销根授权不终止已经运行的远端命令

位置：[exec.ts](../../src/remote/exec.ts) 的启动后生命周期（224–229 行）。只监听调用取消和超时，没有监听 Registry 撤权。两次准入防住了启动前的撤权，但 removeRemote 后既有命令继续写入直到自行结束或超时，与 ADR-0033 的启动后撤权终止要求不符。

复现：真实 Registry 登记根、启动可控进程、移除根后 terminate 调用数仍为 0。需监听授权失效并发送一次终止请求，清理有界，不能把无法确认的终止伪装成成功。

### R5 · P1 · 传输超时与取消无法中断待决 SFTP I/O

位置：[transfer.ts](../../src/remote/transfer.ts) 的传输循环（604–612 行）及其他方向。只在 await 之间检查时间和 signal；连接保持打开却不回 WRITE 时，截止时间与取消均无法使调用结束。预检、校验和清理同样存在等待缺口。

复现：WRITE 保持待决，10ms 预算并取消，60ms 后任务仍未完成；释放伪服务端响应才返回。需将总截止时间与取消覆盖到每个异步阶段，并使失效连接上的请求拒绝；发布可能发生后仍应报告 unknown。

### R6 · P2 · 只启用 exec 的有效环境被 transfer 门禁拒绝

位置：[ssh-exec-backend.ts](../../src/remote/ssh-exec-backend.ts) 的 `verifyCwd`（49–52 行）。执行前总是 openSftp，而该入口要求 transfer 配置及传输扩展。GUI 允许独立启用 exec，因此 helper+exec、不启用 transfer 的合法连接始终返回 `transfer-unavailable`。

复现：真实 manager、exec-only manifest，在连接前就返回 not-started。应由 helper 文件系统验证 cwd，不要求文件传输能力，也不能取消路径边界检查。

### R7 · P2 · 编辑密码引导的连接会丢失访问密钥

位置：[ssh-panel.tsx](../../src/client/ssh-panel.tsx) 的编辑提交（640–642 行）与 [personal-endpoints.ts](../../src/remote/personal-endpoints.ts) 的保存。客户端只回传 credentialId，服务器不保留原 accessKeyId。改一个显示名就让 IdentityFile 从已安装的 keys/accessKeyId 指向不存在的 keys/passwordId。

复现：用 UI 同形请求调用真实保存端点，accessKeyId 消失，生成配置指向原密码凭据 ID。需由服务端在目标和凭据身份相同的情况下保留派生访问密钥；身份变化不得继承。

### R8 · P2 · 超限输出整块丢弃

位置：[exec.ts](../../src/remote/exec.ts) 的 `createSink`（267–269 行）。一块数据越过上限就整块丢弃，而真实 SSH adapter 在退出时一次性提交收集结果；常见的超限输出因此变成空字符串。

复现：真实 adapter 产生 100 字节、上限 64，得到空 stdout 和 truncated=true。应保留剩余预算内的前缀，并分别验证 stdout/stderr、多块与 UTF-8 边界。

### R9 · P2 · 含空格的凭据路径使生成的 SSH 配置不可解析

位置：[personal/ssh-files.ts](../../src/remote/personal/ssh-files.ts) 的 `renderHostBlock`（25–27 行）。IdentityFile / UserKnownHostsFile 未加引号。用户配置 DSH_HOME 或 credentialRoot 含空格时，OpenSSH 报 extra arguments；配置经 Include 链接后可能影响其他 SSH 别名。

复现：真实 `ssh -G -F` 拒绝生成配置。需按 ssh_config 规则引用路径，并验证已解析 known_hosts 路径的后续读取。

### R10 · P2 · 旧会话异步响应覆盖新会话状态

位置：[ssh-panel.tsx](../../src/client/ssh-panel.tsx) 的 `load`（508–512 行）。mounted ref 无法区分同一个对话框中的会话变化；B 的 state 先完成、A 的旧请求后完成时，会显示 A 的绑定，但后续动作使用 B 的 sessionId，可能操作错误项目。

复现：jsdom 保持对话框挂载，从 A 切 B，再逆序完成请求，A 的绑定覆盖 B。应按会话/模式及请求世代丢弃过期响应，同时覆盖变更请求的返回路径。

## 验证证据与边界

审查宿主：macOS，Node 24.18.0、pnpm 11.25.0，DSH 0.2.2-rc.2。

| 检查 | 审查阶段结果 |
| --- | --- |
| build / compat:check / lint / typecheck / pack:check | 全部通过；包内 254 个成员 |
| 全量 `pnpm test`（原有测试） | 122 文件通过、8 跳过；1839 用例通过、132 跳过 |
| `pnpm kernel:probe` | 本机 Seatbelt 真实约束命令通过 |
| `pnpm smoke` | compose 58、behavior 137、journey 92，全通过 |
| `pnpm smoke:packed` | packed behavior 136，全通过 |
| 针对性复现 | 2 文件、10 用例全部命中缺陷；断言的是错误现状 |

初次在 Agent sandbox 下运行全量测试，19 项因本机 IPC peer/lease 权限失败；获得宿主运行授权后全量通过，未将这些环境限制误报为代码缺陷。本次未重跑全部 DSH/OS 矩阵、Linux/Windows 内核或真实远端 VPS 故障演练。SFTP 权限验证使用本机真实 OpenSSH 服务端；主机参数验证使用 ssh -G，不等同于真实网络中间人演练。broker 验证使用真实本地 IPC 与可控远端替身。

修复前复现脚本保存在 [复现补丁](./2026-11-15-ssh-branch-review-repros.patch)。在被审提交的独立工作区应用后运行：

```bash
git apply docs/reviews/2026-11-15-ssh-branch-review-repros.patch
pnpm exec vitest run tests/review-ssh-findings.spec.ts tests/review-ssh-client.spec.tsx --reporter=verbose
```

脚本需要 macOS 的 `/usr/libexec/sftp-server` 和 OpenSSH，不连接真实远端、不读取用户凭据。修复后的正式回归测试断言正确行为，不能再用这些历史错误断言判定修复是否通过。

## 修复追踪

用户已授权连续逐项修复、每项验证和独立提交。完成后逐项在此记录结果，最终补充全量复验。

- R1 已修复：SFTP 强制主机验证、禁止 agent 转发与自动更新主机密钥。真实 OpenSSH 配置解析回归和 SFTP 套件通过。

- R2 已修复：OPEN 正确编码 ATTRS flags 与 permissions；真实 OpenSSH 服务端验证 0600、0640 和默认 umask 三种创建结果，SFTP 套件通过。

- R3 已修复：broker 的 BROKER-LOST 在即时和缓冲事件路径均映射为 RemoteConnectionLost；真实 IPC 的早到/晚到断线回归与 broker 套件通过。

- R4 已修复：spawn 起监听撤权并周期性重新准入，跨 Host/只读切换可终止；清理等待有界，超时返回 unknown。真实 Registry 回归覆盖撤权、待决启动、follower 与模式收窄，类型检查通过。

- R5 已修复：总 I/O 预算覆盖待决请求、连接和最终准入；中断废弃连接，清理有界，迟到连接关闭。新增 11 项停滞/取消回归，传输、工具和环境相关 68 项测试与类型检查通过。

- R6 已修复：cwd 验证复用 helper 只读探针，与 transfer 解耦；本机真实文件系统验证 exec-only、嵌套目录、symlink 与越界拒绝，相关套件和类型检查通过。

- R7 已修复：Host 在 CAS 保存中保留同身份访问密钥，目标/凭据/主机指纹变化不继承；六种编辑回归与个人配置套件通过。

- R8 已修复：超限块保留预算内前缀，截断的 UTF-8 尾部不补乱码；真实 adapter 的 stdout/stderr、UTF-8 与多块边界回归通过。

- R9 已修复：托管 IdentityFile、UserKnownHostsFile 与 Include 路径正确引用；保留 ssh -G 去引号后的完整托管 known_hosts 路径。真实 OpenSSH Include/解析回归与相关套件通过。
