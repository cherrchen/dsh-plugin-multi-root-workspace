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
- DSH Desktop 的 Host 是 Electron，TLS 栈是 BoringSSL；BoringSSL 没有 GCM-PSK，只有 `ECDHE-PSK-CHACHA20-POLY1305`、`PSK-AES256-CBC-SHA` 等早期套件。`tls.createSecureContext()` 在本地直接失败，远端收不到 ClientHello。

「测试连接」只执行 OpenSSH 命令，不建立转发流，所以能通过；登记会打开 Helper 并为目录探针建立 TLS 转发流，所以必然失败。

## 诊断方法

1. 在 DSH Desktop 的 Electron 运行时确认套件缺失：

   ```sh
   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" -e \
     "const t=require('node:tls');console.log(t.getCiphers().filter(c=>/psk/i.test(c)))"
   ```

   BoringSSL 的输出里没有 `psk-aes256-gcm-sha384`，但有 `ecdhe-psk-chacha20-poly1305`。
2. 在同一运行时执行 `tls.createSecureContext({ ciphers: 'PSK-AES256-GCM-SHA384', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' })`，应复现 `ERR_SSL_NO_CIPHER_MATCH`。
3. 检查 Helper 记录的 `integrity`：`3` 才包含服务端 fallback 入口。

## 已验证的解决方案

- `src/compat/ssh-stream-ciphers.ts` 在 Host 加载 `@deepseek-ai/dsh-ssh` 前安装一个只针对目标套件的 `tls.connect` 包装：BoringSSL 上替换为
  `ECDHE-PSK-CHACHA20-POLY1305:PSK-AES256-CBC-SHA`（按运行时实际上报裁剪），plain Node 上不安装补丁。
- 插件生成的 `helper-entry.mjs` 在加载上游 Helper 前给 `tls.createServer` 的 cipher 列表追加同一组 fallback，保留上游 GCM 套件优先。
- 仍是 PSK 认证，不加入证书套件；`ECDHE-PSK-CHACHA20-POLY1305` 是 AEAD 且带前向保密。
- Helper 入口格式升级为 `integrity: 3`。旧 Helper 会报 `helper-outdated`：在对应连接卡片上重新点「安装 Helper」，然后重新登记即可。

决策与备选方案见 [ADR-0051](../decisions/ADR-0051-ssh-stream-psk-boringssl-fallback.md)，当前配置语义见 [SSH 远端环境参考](../reference/ssh-remote-environments.md#helper-安装与密码访问密钥引导)。

## 回归覆盖

- `tests/ssh-stream-ciphers.spec.ts`：客户端三态选择、只改写目标 options、服务端追加 fallback、真实 Unix/TCP TLS 握手协商到 `ECDHE-PSK-CHACHA20-POLY1305`。
- `tests/helper-entry-integrity.spec.ts`：生成的入口仍能通过文件集校验并完成 hello。
- `tests/ssh-environment.spec.ts`：`integrity` 1/2/缺失均以 `helper-outdated` 拒绝，3 才进入后续准入。
