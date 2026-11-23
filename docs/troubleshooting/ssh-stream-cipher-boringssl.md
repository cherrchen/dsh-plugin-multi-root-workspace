# 登记远端工作目录报 `NO_CIPHER_MATCH`：Electron/BoringSSL 不支持上游的 GCM-PSK 套件

## 症状

- 在 DSH Desktop（Electron）里打开 Workspace Folders，选中已安装 Helper 的远端连接，点击「登记到工作区」（或 `remotes.add`）。
- 面板顶部显示通用「宿主内部错误。」，技术详情为
  `error:100000b1:SSL routines:OPENSSL_internal:NO_CIPHER_MATCH`。
- 同一个连接的「测试连接」成功；SFTP 目录浏览也正常。
- 用同版本的独立 Node 启动 Host，或把同一 Helper 接到独立 Node 上，登记成功。

## 根本原因

上游 `@deepseek-ai/dsh-ssh` 为每条转发流固定使用 `PSK-AES256-GCM-SHA384`，Host 侧 `tls.connect` 与远端 Helper 侧 `tls.createServer` 都必须实现该套件。

- 远端 Helper 跑在普通 Node/OpenSSL 上，支持 GCM-PSK。
- DSH Desktop 的 Host 是 Electron，TLS 栈是 BoringSSL；BoringSSL 没有 GCM-PSK，但实现了 `ECDHE-PSK-CHACHA20-POLY1305`。`tls.createSecureContext()` 在本地直接失败，远端收不到 ClientHello。

「测试连接」只执行 OpenSSH 命令，不建立转发流，所以能通过；登记会打开 Helper 并为目录探针建立 TLS 转发流，所以必然失败。

## 诊断方法

1. 在 DSH Desktop 的 Electron 运行时确认套件缺失：

   ```sh
   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e \
     "const t=require('node:tls');console.log(t.getCiphers().filter(c=>/psk/i.test(c)))"
   ```

   BoringSSL 的输出里没有 `psk-aes256-gcm-sha384`，但有 `ecdhe-psk-chacha20-poly1305`。
2. 在同一运行时执行 `tls.createSecureContext({ ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' })`，应复现 `ERR_SSL_NO_CIPHER_MATCH`。
3. 检查 Helper 目录：`helper-entry-v3.mjs` 存在且与 Host 计算的摘要一致，才包含服务端 fallback 入口；`helper-entry.mjs` 始终保留为可回退的 legacy 入口。

## 已验证的解决方案

- `src/compat/ssh-stream-ciphers.ts` 在 Host 加载 `@deepseek-ai/dsh-ssh` 前安装一个只针对上游 `authenticateStream` 精确参数形状的 `tls.connect` 包装：BoringSSL 上替换为
  `ECDHE-PSK-CHACHA20-POLY1305`，plain Node 上不安装补丁；调用方自己的 cipher 排除项保持原样。
- 插件安装两个入口：`helper-entry.mjs` 保持 beta.2 的逐字节模板，`helper-entry-v3.mjs` 在加载上游 Helper 前给 `tls.createServer` 的 cipher 列表追加 ChaCha20-PSK。BoringSSL Host 启动 v3 入口，plain Node Host 继续启动 legacy 入口。
- 仍是 PSK 认证，不加入证书套件；`ECDHE-PSK-CHACHA20-POLY1305` 是 AEAD 且带前向保密。不使用 CBC 套件。
- 记录里的 `integrity` 仍是 2，`helperPath` 仍指向 `helper-entry.mjs`，所以重装不会改变 `bindingDigest`，已登记 Root 不会变成 `withheld`，也不需要重新登记。
- 旧 Helper 没有 v3 入口时，Desktop 会报 `helper-outdated`：在对应连接卡片上重新点「安装 Helper」即可；Node Host 不受影响。

决策与备选方案见 [ADR-0051](../decisions/ADR-0051-ssh-stream-psk-boringssl-fallback.md)，当前配置语义见 [SSH 远端环境参考](../reference/ssh-remote-environments.md#helper-安装与密码访问密钥引导)。

## 回归覆盖

- `tests/ssh-stream-ciphers.spec.ts`：客户端三态选择、只改写目标 options、服务端追加 fallback、真实 Unix/TCP TLS 握手协商到 `ECDHE-PSK-CHACHA20-POLY1305`。
- `tests/helper-entry-integrity.spec.ts`：生成的入口仍能通过文件集校验并完成 hello。
- `tests/ssh-environment.spec.ts`：`integrity` 缺失/1 以 `helper-outdated` 拒绝，2 才进入后续准入。
- `tests/command.spec.ts`：`helper-outdated` 经面板 RPC 原样透传，不再变成 `panel/internal`。
