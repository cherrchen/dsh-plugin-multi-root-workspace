# ADR-0051：SSH 转发流的 BoringSSL PSK 套件回退

## 状态

Accepted，2026-11-23。实施随 `0.1.24` 线的下一个 beta 发布。

## 背景

上游 `@deepseek-ai/dsh-ssh` 的转发流固定使用 `PSK-AES256-GCM-SHA384`：Host 用 `tls.connect`，远端 Helper 用 `tls.createServer`，两侧都必须能创建该套件。

DSH Desktop 的 Host 运行在 Electron 44 / BoringSSL 上。BoringSSL 实现了早期 PSK 家族中的 `ECDHE-PSK-CHACHA20-POLY1305`，但没有 GCM-PSK 套件。`tls.createSecureContext({ ciphers: 'PSK-AES256-GCM-SHA384' })` 在本地直接抛 `ERR_SSL_NO_CIPHER_MATCH`（`error:100000b1:SSL routines:OPENSSL_internal:NO_CIPHER_MATCH`），远端收不到握手。

症状是「测试连接」成功、登记失败：测试连接只执行 OpenSSH 探测；登记会打开 Helper 并为只读目录探针建立转发流，Host 在本地创建 TLS 上下文时就中断。

上游不能修改。远端 Helper 由插件安装，入口脚本由插件生成，因此插件在两侧各有一个可控注入点。

## 决策

1. **Host 端只改写上游转发流的那一次调用。** 在动态求值 `@deepseek-ai/dsh-ssh` 之前，`src/compat/ssh-stream-ciphers.ts` 检查当前运行时的 `tls.getCiphers()`：
   - 支持上游套件：不安装补丁，行为与 plain Node 完全一致；
   - 不支持但支持 AEAD fallback：替换 `node:tls` 的 `connect`，只在 options 与上游 `authenticateStream` 的形状完全一致时改写：`ciphers === 'PSK-AES256-GCM-SHA384'`、`minVersion/maxVersion === 'TLSv1.2'`、`rejectUnauthorized === true`、`pskCallback` 与 `checkServerIdentity` 是函数、携带 `socket`。调用方自己的 cipher 排除项（例如 `PSK-AES256-GCM-SHA384:!PSK-AES256-CBC-SHA`）或额外套件因此保持原样；
   - 两者都不支持：在打开任何流之前拒绝，并给出明确错误。
   替换后调用 `syncBuiltinESMExports()`，使上游已经或即将通过 `import { connect } from 'node:tls'` 绑定的具名导入看到补丁函数。

2. **远端 Helper 使用附加入口，不改记录。** `renderLegacyHelperEntry` 保留已发布 beta.2 的 `helper-entry.mjs` **逐字节模板**；`renderHelperEntry` 在同一个完整性校验之后、加载上游 Helper 之前插入固定的服务端 shim。安装时把两者分别写成 `helper-entry.mjs` 与 `helper-entry-v3.mjs`，记录的 `helperPath` 仍指向 `helper-entry.mjs`。

3. **按运行时选择入口。** `verifyHelperEntry()` 用一次 SSH 探测同时核对两个文件：
   - 记录的 legacy 入口必须匹配，否则 `helper-hash-mismatch`；
   - 附加入口存在且匹配时报告 `current: true`。
   BoringSSL Host（`clientPskPlan().kind === 'fallback'`）启动 `helper-entry-v3.mjs`，缺失时以 `helper-outdated` 要求重装；plain Node Host 继续启动 `helper-entry.mjs`，OpenSSL → OpenSSL 路径不经过 shim。

4. **fallback 只保留 AEAD 套件。** 唯一 fallback 是 `ECDHE-PSK-CHACHA20-POLY1305`（AEAD、前向保密、HMAC-SHA256）。不使用 `PSK-AES256-CBC-SHA`：它虽然可用，但不是 AEAD，会降低上游套件的安全属性。运行时没有 ChaCha20-PSK 时宁可拒绝。PSK 仍为强制，不加入证书套件，也不取消 `rejectUnauthorized`。

5. **入口字节固定，不依赖构建器。** Helper 入口会与 Host 计算的摘要比对，因此服务端 shim 是固定的 JavaScript 模板，绝不使用 `Function.prototype.toString()`。源码与发布构建对同一 `treeSha256` 必须生成相同字节；回归用固定摘要钉住 legacy 与 current 两份模板。

6. **升级与回退都不移动授权。** `integrity` 保持 2，`helperPath`、`sha256`、`treeSha256` 不变，`bindingDigest` 因此不变，已登记的远端 Root 不会因重装 Helper 变成 `withheld`。beta.2 Host 读取新配置时仍只看到 `integrity: 2` 和 `helper-entry.mjs`，该文件保持旧字节，所以可以继续校验和启动；新 Host 只在需要时读取附加文件。旧 Helper 在 Desktop 上重装一次即可，Node Host 无需重装。

7. **稳定错误码穿透面板。** 旧 Helper 的 `helper-outdated` 由 `SshEnvironmentError` 携带；`src/command.ts` 把它列入稳定错误码透传集合，面板显示可操作的「重新安装 Helper」而不是 `panel/internal`。

## 备选方案

- **在独立 Node 子进程中做 TLS 客户端中继。** 保留原套件，但 DSH Desktop 不自带独立 Node：`Contents/Resources/runtime/bin/node` 只是 `ELECTRON_RUN_AS_NODE=1` 的 wrapper，仍是 BoringSSL；依赖用户自行安装 Node 不可接受。
- **只把 Host 改成 CBC 套件。** 远端服务端仍只提供 GCM；而且 CBC 不是 AEAD。
- **修改远端安装包里的 `stream-security` 文件。** 违反「不修改上游」，并会破坏 `treeSha256` 完整性校验。
- **把 `integrity` 升到 3 并覆盖 `helper-entry.mjs`。** 会改变 `bindingDigest`、让既有授权进入 `withheld`，同时让 beta.2 Host 与回退路径无法读取配置/校验入口。
- **只在上游修复。** 上游不提供版本化能力开关；本 ADR 的回退在标准 Node 上保持原路径，可与未来上游修复共存。

## 影响

- DSH Desktop 可以登记并执行远端 Root；plain Node Host 的 TLS 与入口字节行为不变。
- 桌面端已安装的旧 Helper 需要重装一次（`helper-outdated`）；重装不要求重新登记 Root。
- 记录与配置 schema 不变（`integrity: 1 | 2`），beta.2 及更早 Host 可读取新配置并继续使用 legacy 入口，回退路径可执行。
- 本插件新增对 `syncBuiltinESMExports()` 的依赖；它只影响被替换的 `tls.connect`，不改变其他核心模块的值。
- fallback 是 PSK-only 的受限替换：隧道仍由每流 256-bit capability 认证；ChaCha20-PSK 提供 AEAD 与前向保密。
- 若未来 Electron 的 BoringSSL 实现 GCM-PSK，`clientPskPlan()` 自动回到 `native`，无需再改代码。
- 回归门禁：`tests/ssh-stream-ciphers.spec.ts` 覆盖三态选择、精确参数形状、固定模板摘要和真实 fallback 握手；`tests/helper-entry-integrity.spec.ts` 覆盖双入口校验；`tests/command.spec.ts` 覆盖 `helper-outdated` 的面板透传；`tests/remote-personal-ops.spec.ts` 覆盖重装后 `bindingDigest` 不变。

## 相关

- [SSH 远端环境参考](../reference/ssh-remote-environments.md)
- [故障排查：登记时 NO_CIPHER_MATCH](../troubleshooting/ssh-stream-cipher-boringssl.md)
- [ADR-0049](./ADR-0049-ssh-custody-modes.md)
