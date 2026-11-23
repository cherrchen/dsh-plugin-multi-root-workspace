# ADR-0051：SSH 转发流的 BoringSSL PSK 套件回退

## 状态

Accepted，2026-11-23。实施随 `0.1.24` 线的下一个 beta 发布。

## 背景

上游 `@deepseek-ai/dsh-ssh` 的转发流固定使用 `PSK-AES256-GCM-SHA384`（[stream-security.ts](https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/ssh/ssh/src/stream-security.ts)）：Host 用 `tls.connect`，远端 Helper 用 `tls.createServer`，两侧都必须能创建该套件。

DSH Desktop 的 Host 运行在 Electron 44 / BoringSSL 上。BoringSSL 实现了早期 PSK 家族（`ECDHE-PSK-CHACHA20-POLY1305`、`PSK-AES256-CBC-SHA` 等），但没有 GCM-PSK 套件。`tls.createSecureContext({ ciphers: 'PSK-AES256-GCM-SHA384' })` 在本地直接抛 `ERR_SSL_NO_CIPHER_MATCH`（`error:100000b1:SSL routines:OPENSSL_internal:NO_CIPHER_MATCH`），远端收不到握手。

症状是「测试连接」成功、登记失败：测试连接只执行 OpenSSH 探测；登记会打开 Helper 并为只读目录探针建立转发流，Host 在本地创建 TLS 上下文时就中断，面板把底层异常压成「宿主内部错误」。

上游不能修改。远端 Helper 由插件安装，入口脚本 `helper-entry.mjs` 由插件生成，因此插件在两侧各有一个可控注入点。

## 决策

1. **Host 端只改写目标调用。** 在动态求值 `@deepseek-ai/dsh-ssh` 之前，`src/compat/ssh-stream-ciphers.ts` 检查当前运行时的 `tls.getCiphers()`：
   - 支持上游套件：不安装补丁，行为与 plain Node 完全一致；
   - 不支持但支持 fallback：替换 `node:tls` 的 `connect`，只改写第一个参数为 options 且 `ciphers` 字符串包含 `PSK-AES256-GCM-SHA384` 的调用；
   - 两者都不支持：在打开任何流之前拒绝，并给出明确错误。
   替换后调用 `syncBuiltinESMExports()`，使上游已经或即将通过 `import { connect } from 'node:tls'` 绑定的具名导入看到补丁函数。

2. **远端 Helper 入口追加 fallback。** `renderHelperEntry()` 在完整性校验之后、`await import(.../helper.js)` 之前注入一段自包含 preamble：包装 `tls.createServer`，仅当 cipher 列表包含上游套件时追加远端 Node 实际上报的 fallback，然后同样 `syncBuiltinESMExports()`。上游服务端列表保持第一优先，因此 Node ↔ Node 仍协商 `PSK-AES256-GCM-SHA384`。

3. **fallback 顺序。** 首选 `ECDHE-PSK-CHACHA20-POLY1305`（AEAD、前向保密、HMAC-SHA256），其次 `PSK-AES256-CBC-SHA`。两者都仍是 PSK 认证；不加入任何证书套件，也不取消 `rejectUnauthorized`。

4. **Helper 入口格式版本化为 `integrity: 3`。** 旧入口没有服务端 fallback，无法与 BoringSSL Host 协商；记录为 1/2 的 Helper 以既有 `helper-outdated` 拒绝，用户在连接卡片重新安装即可。持久化 schema 仍接受 1/2/3 以便读取旧记录。

5. **不修改 `node_modules` 或上游源码。** 远端安装的 `@deepseek-ai/dsh-ssh` 文件集摘要 `treeSha256` 不变，变的是插件生成的入口脚本；`verifyHelperEntry()` 用同一个渲染函数校验新入口。

## 备选方案

- **在独立 Node 子进程中做 TLS 客户端中继。** 保留原套件，但 DSH Desktop 不自带独立 Node：`Contents/Resources/runtime/bin/node` 只是 `ELECTRON_RUN_AS_NODE=1` 的 wrapper，仍是 BoringSSL；依赖用户自行安装 Node 不可接受。
- **只把 Host 改成 CBC 套件。** 远端服务端仍只提供 GCM，依旧 `NO_CIPHER_MATCH`。
- **修改远端安装包里的 `stream-security` 文件。** 违反「不修改上游」，并会破坏 `treeSha256` 完整性校验。
- **去掉转发流 TLS，依赖 SSH 通道本身。** 会丢掉逐流 PSK 认证和本地转发端点的对端认证，安全面更大。
- **只在上游修复。** 上游不提供版本化能力开关，且本插件的发布不能等待上游；本 ADR 的回退在标准 Node 上保持原路径，可与未来上游修复共存（届时 `getCiphers()` 支持 GCM，Host 不安装补丁）。

## 影响

- DSH Desktop 可以登记并执行远端 Root；Node Host 的 TLS 行为不变。
- 已安装的旧 Helper 必须重装一次（`helper-outdated`）。
- 本插件新增对 `syncBuiltinESMExports()` 的依赖；它只影响被替换的 `tls.connect`，不改变其他核心模块的值。
- fallback 是 PSK-only 的受限降级：隧道仍由每流 256-bit capability 认证；`ECDHE-PSK-CHACHA20-POLY1305` 提供前向保密。CBC 仅在运行时没有 ChaCha 时使用。
- 若未来 Electron 的 BoringSSL 实现 GCM-PSK，`clientPskPlan()` 自动回到 `native`，无需再改代码。
- 回归门禁：`tests/ssh-stream-ciphers.spec.ts` 覆盖三态选择、只改写目标 options、真实 fallback 握手，以及生成入口包含服务端 preamble；`tests/helper-entry-integrity.spec.ts` 继续证明生成入口可启动并通过文件集校验。

## 相关

- [SSH 远端环境参考](../reference/ssh-remote-environments.md)
- [故障排查：登记时 NO_CIPHER_MATCH](../troubleshooting/ssh-stream-cipher-boringssl.md)
- [ADR-0049](./ADR-0049-ssh-custody-modes.md)
