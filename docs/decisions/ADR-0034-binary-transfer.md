# ADR-0034：源码和二进制产物的跨环境复制

**状态** Accepted · 2026-11-06。已接受架构合同，实验默认关闭；各项能力须通过对应验收才可开放。

## 背景（Fact）

Issue #32 的两段传输有不同的授权方向：开发机可向构建机交付源码，构建机可向设备交付产物。构建机不需要取得设备私钥。DSH FS 有 readBytes/readByteRange 和带版本的文本修改，rc.1 没有 writeBytes 或跨环境原子 rename。官方远端 FS 读接口也未携带根内读取策略。[FileSystem](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/fs/fs/src/index.ts) / [SSH FS](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/ssh/fs-ssh/src/index.ts)

## 决策

采用独立的 `remote_copy({from, to})`。每端必填环境、根 ID 和根内相对文件名，首版仅复制一个普通文件到**尚不存在**的目标。Linux/macOS 本地→Ubuntu、Ubuntu→设备、远端→本地的方向均由部署方分别配置。远端↔远端也经可信 Host 有界中转；不把对端凭据交给远程进程。复制不删除源文件，不解释 shell 通配符。

| 阶段 | 要执行与验证的事 |
| --- | --- |
| 双端准入 | 同一个 session 与 Registry owner 的一次排序快照校验源读取/导出、目标创建/导入、允许的端点配对及工具 cap。SSH 端按[入口权限表](./ADR-0030-environment-and-root-identity.md)继承会话；只读可作为已授权来源，但作为目的地时须在 staging 前拒绝。下载到本地仍需通过本地根访问级别和 protectedHome/deny 检查。在打开源、发送内容或创建 staging **之前**拒绝缺任一授权的请求。 |
| 打开 | 各端按自己的路径语义，从已验证根定位普通文件或目标父目录。绑定打开的对象和目录，拒绝符号链接、junction/reparse point、非常规文件、越界及无证明的多硬链接对象。以最小权限排他创建临时文件，置于与目标同一文件系统、只有受信传输主体能改动的 staging 目录。仅能 realpath 后再按裸路径 open 的后端无法抵抗替换竞态，不开放该组合。 |
| 流与校验 | 源打开时记录版本与长度；按块背压，限定单文件字节数、并发、时限及 staging 配额，计算 SHA-256。校验实际读取字节数与源版本稳定性，目标端回读 staging 或使用受信服务端摘要比较；不把发送端哈希当作落盘证明。传输结果只含两端、操作 ID、字节数、摘要、状态，不回显凭据或文件内容。 |
| 发布 | 长传输可在撤权后取消。在发布前重取当前会话模式，重新向 owner 对两端准入并复核对象身份；已发送到目标 staging 的字节不能追回。用同 FS 的原子 no-replace 发布，拒绝先 stat 再普通 rename 的覆盖竞态。只在收到发布确认后报 committed。跨设备或无此原语时拒绝。 |
| 收尾 | 返回阶段、确认字节数及清理状态。未发布且已清理为 failed/cancelled；能证实的残留 staging 或批次部分提交为 partial；发布请求发出后失联为 unknown。仅清理该操作创建且身份可核实的 staging；重新连接后以新只读准入核对最终对象和摘要，绝不自动重发。 |

**校验与发布必须指向同一对象。** 保持对源、staging 对象和发布父目录的绑定直至提交。其他工作进程若能在验哈希后改写文件内容、替换临时名，或把父目录移出授权树，即使最终 rename/link 是原子的，也不能开放该方向。根内写者存在时需由受信服务提供相应的对象绑定和目录隔离；若 SFTP 只提供普通路径调用，则仅在部署能排除这些竞态时开放。允许已发布文件被有权写者在发布后修改，结果中的摘要只描述本次提交。

**撤权后的清理。** 清理权限仅及本操作独占、可验证的 staging 对象。重连、身份变化或撤权后不能证明这项权限时，不按路径删除，报告残留交给受信部署方回收。发布成功但清理失败要分别报告目标已提交和 staging 残留，不能提示重传。丢失发布确认后再读到相同摘要只能说明当前内容一致，不能据此认定最初是哪次操作写入。

本地目标需要为 Transfer 增加受 **同一个 Registry/Scope fence** 保护的二进制创建与发布端口。不可直接从工具 handler 调 Node fs，也不可用 writeText/base64 或通用 shell 解码绕过授权。远端可先试受管的 SFTP-only 账户：管理员将其锁定在一个导入或导出目录，禁 shell/转发，固定主机密钥并隔离其他写者。要求端点能证明上述打开、硬链接和排他发布条件；例如验证受限 SFTP 服务的原子硬链接创建后再清理临时名。若服务只支持可能覆盖的 rename、无法限制目录竞态，或不能证明实际内容，判该动作 unsupported。支持 SFTP 本身不能证明这些条件。对设备只授予上传时，另行提供仅校验本次 staging 的可信摘要接口，否则仍拒绝发布。

## 备选与后续能力

- 可用部署方配置的 rsync/SSH 进行目录同步，适合初始源码树，但会引入递归、软硬链接、远端 shell 和删除语义。首期用有界文件清单逐文件复制即可演示最小构建。目录树作为后续独立能力：限制深度、条数、总字节数；逐文件双端验证；显式报告部分完成；覆盖须有目标版本守卫。禁止自动同步删除或提权设置权限位。
- 可用官方 Helper 作为安全传输端点，待其提供有界二进制 sink、根约束、安全创建和发布公开 API 后优先替换 SFTP adapter。拒绝调用私有 RPC、拼接 scp/rsync 命令或将跨机 move 伪装成原子操作；这些路线均无法继承文本 FS 的版本和权限合同。
- **验收与回滚**：Linux/macOS 本地导出、Ubuntu→设备的中转及反向下载须分别在真实端点证明；包括大于单个 RPC frame 的二进制、零字节、现存目标、并发抢占文件名、源中途变化、只读下载目的地、发布丢应答。未通过的一侧或方向禁用；关闭传输先拒绝新请求，再取消 staging、报告在飞结果，不删除已发布的用户文件。

## 复制目的收窄（2026-11-10，外部评审修正）

保留原 Accepted 决定（`remote_copy` 与 `remote_bash` 并存）不变，追加：模型可见的复制目的必须是独立的 chroot SFTP-only 账户——目的环境 `transfer` 声明 `destinationIsolation: "chroot-sftp"`，且不得与同 `namespace`+`account` 的 helper/带 `exec` 环境共存（证明期 `destination-isolation-required`）；helper 环境不能作复制目的，构建产物由该账户写入后经 export/中转取回。SFTP 内所见路径按 chroot 监狱内绝对路径理解（如 `/workspace`），非宿主机 realpath；父目录/staging 逐段检查是纵深防御而非 dirfd 级 TOCTOU 保证，真实的 chroot、属主与独立写者隔离仍属部署证据，清单声明本身不构成证明。
