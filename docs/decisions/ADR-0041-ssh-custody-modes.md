# ADR-0041：SSH 远端环境的三档凭据托管模式

**状态** Accepted · 2026-11-13（维护者决定）。本文在 [ADR-0040](./ADR-0040-credential-broker.md) 的 broker 托管之外，增加两档更轻的托管方式，并把三档统一到一个用户可见的设置入口。实现与验证状态归[路线图总账](../plans/active/2026-09-12-multi-root-workspace.md)；部署与使用步骤归 [SSH 远端环境使用参考](../reference/ssh-remote-environments.md)。

## 背景（Fact）

- 到 2026-11-13，远端工具只能在 ADR-0040 的“硬化”部署下挂载：root 保护的部署清单、独立 broker 账户、内核认证 socket、`fullAccessDisabled` 与 `confinementProbe` 的部署证据、chroot SFTP 复制目的与独立写者。2026-11-11 的外部评审确认这条路径成立，但它要求 root、专用账户与 unit 文件，个人用户无法在 GUI 中完成。
- 维护者判断：对个人机器、一次性 VM 与可信 Agent，这套隔离的成本远高于收益。真正有价值、且与凭据托管无关的部分是：显式工具、每次 Registry 准入、清单约束（动作与传输配对）、路径校验、不覆盖发布与 `unknown` 语义。
- 上游 `SshConnection`（`dsh-ssh` 0.2.2-rc.1/rc.2）总是以 `ssh -T -M -S <私有 socket> -o BatchMode=yes -o StrictHostKeyChecking=yes -o ForwardAgent=no … <host alias>` 启动 OpenSSH，从 PATH 取 `ssh`，读取用户的 `~/.ssh/config`；它不接受 `-F`、密码或额外选项。Helper（`lib/helper.js`）不是单文件：它依赖 cordis、zod 与 `dsh-fs`，远端须有与 Host 精确同版的 `@deepseek-ai/dsh-ssh` 依赖树。

## 决策

### 1. 三档模式

| 档位 | Host 凭据 | 目标账户 | 复制目的 | 部署清单来源 | 适用 |
| --- | --- | --- | --- | --- | --- |
| **个人**（默认） | Host 进程内直连；用户 `~/.ssh` 别名，或插件面板托管的密钥/密码 | 用户自己的账号 | 不做 chroot；只 pull，或 push 到用户自己拥有的目录 | 插件个人配置文件（用户属主） | 个人、一次性 VM、可信 Agent |
| **团队** | broker 独立账户（ADR-0040 的 broker 与 socket 认证） | 共享构建账户 + root 只读 Helper | 必须是声明 `destinationIsolation: "chroot-sftp"` 的 SFTP 账户 | root 保护的部署清单 | 共享构建机、多人 |
| **硬化** | broker + 配额/审计/吊销 | 专用账户 + chroot + 独立写者 | chroot + 目的隔离（复制目的账户不得兼作执行） | root 保护的部署清单 | 模型开放、生产 |

模式由 `multi-root-remote-tools` 设置的 `mode` 字段选择，默认 `personal`；整个功能仍由同一设置的 `enabled`（默认 `false`）开关，并在插件详情页带黄色“实验性”标签。

**三档共有、不随档位放宽的部分：** `remote_copy` / `remote_bash` 仍是仅有的模型入口；每次调用经 Registry 两段准入（A/B）；绑定只授予声明的动作与传输配对；远端路径规范化校验；本地 sink 与远端 staging 的不覆盖发布；发布不确定时报 `unknown` 且不重放；远端记录不进入本地 scope、方言、指令或 Skills。

### 2. 个人模式

- **不装 broker**：`SshEnvironmentManager` 在 Host 进程内运行官方 SSH 栈；环境在内存中一律视为 `credentialIsolation: "unattested"`，个人模式接受它，不再承诺“Agent 拿不到密钥”。不安装 `remote-profile-guard`，不拒绝允许 `danger-full-access` 的 profile。
- **个人配置文件** `<sharedStorageRoot>/multi_root_workspace.remote-personal.json`：属当前 uid、0600、非 symlink、所在目录不可被 group/other 写、不得位于任何绑定的本地 primary 内。内容是环境（主机名、端口、用户、平台、主机钥指纹、凭据引用、Helper、workspace、可选 exec/transfer）与绑定（与部署清单同一绑定 schema）；读入时转换为同一 `DeploymentManifest` 形状，因此准入、记录域与 `remote-1` 协议不分叉。写入走原子替换并带 `revision` 比较，冲突为 `personal-config-conflict`。各 Host 在列表与准入前按 stat 身份检测变更并重载，摘要变化后 follower 重新 hello。
- **凭据**：两种来源。
  - `ssh-config`：引用用户 `~/.ssh/config` 中已有的别名。添加时以 `ssh -G` 解析出的用户、主机与端口登记，连接时账户必须仍然一致。
  - `managed`：插件凭据根 `<sharedStorageRoot>/multi_root_workspace.ssh/`（0700）下的密钥或密码。面板可生成 ed25519 密钥、导入私钥（带口令的私钥在导入时去掉口令保存）或保存密码；列表只返回标签、类型、公钥与指纹，**任何端点都不返回私钥或密码**。删除被环境引用的凭据为 `credential-in-use`。
  - 上游 `BatchMode=yes` 禁止交互认证，因此密码凭据不直接驱动上游连接：保存使用密码的环境时，插件用密码（`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`，脚本只读取凭据根中的密码文件）登录一次，把为该环境生成的访问密钥追加到远端 `~/.ssh/authorized_keys`，之后连接一律用该密钥。密码保留在凭据根内，供重新安装访问密钥。
  - 托管别名 `dsh-<environmentId>` 写入凭据根内生成的 `ssh_config`（`IdentitiesOnly yes`、插件 `known_hosts`、`StrictHostKeyChecking yes`、`BatchMode yes`、`ForwardAgent no`、`UpdateHostKeys no`）。因为上游只读 `~/.ssh/config`，用户须在面板中一次性确认“链接到 ~/.ssh/config”，插件在该文件**首行**加入一条 `Include <凭据根>/ssh_config`（先备份原文件）；未链接时托管环境的连接报 `ssh-config-not-linked`。
- **主机钥**：首次信任（TOFU）。面板用 `ssh-keyscan` 取指纹给用户确认，确认后写入插件 `known_hosts` 并记入配置；此后连接仍要求 known_hosts 恰好一把匹配钥且指纹等于记录值。`ssh-config` 来源沿用用户自己的 known_hosts。
- **身份检查的放宽**：个人模式不再要求 `ssh -G` 解析出 `batchmode yes`、`stricthostkeychecking yes`、`forwardagent no`、`updatehostkeys no`——上游在命令行强制了前三项，后者只影响 known_hosts 改写；账户一致与主机钥检查保留。
- **Helper**：面板“安装 Helper”经插件自己的 `ssh` 在远端执行 `npm install --prefix ~/.dsh-helper/<版本> @deepseek-ai/dsh-ssh@<Host 同版>`，再比较远端 `helper.js` 的 SHA-256 与 Host 本机同版文件；一致才记入配置。用户也可填写已安装的 `nodePath` / `helperPath`。`~/.dsh-helper` 可被目标账户改写，这是个人模式接受的风险；需要 root 只读 Helper 的用户应选团队模式。
- **复制目的**：不要求 chroot；绑定由用户声明 `import`/`export`，建议只 pull 或 push 到自己拥有的目录。

### 3. 团队模式

沿用 ADR-0040 的 broker、socket 内核认证、凭据根不可读检查、清单摘要一致与 root 保护的部署清单。相对硬化模式放宽三项：不要求 `fullAccessDisabled` 与 `confinementProbe` 的部署记录；不安装 `remote-profile-guard`、不拒绝允许 `danger-full-access` 的 profile；`import` 绑定仍必须指向 `chroot-sftp` SFTP 目的，但不再拒绝“同 namespace + 账户另有 helper/exec 环境”（独立写者）。broker 的 socket、UID、凭据根与清单路径可在 GUI 设置中填写，也可由 profile 行配置提供。

接受的风险：同 UID 且拥有完全访问的 Agent 进程可以绕过 Registry 直接连接 broker socket，并把构建账户能写的任何位置作为目标。

### 4. 硬化模式

即 2026-11-11 评审通过的现行实现，行为不变：全部 broker 事实只来自 profile 行配置（部署方所有），GUI 只读显示其状态，不提供可写字段。

### 5. 切换语义

`enabled`、`mode` 或团队字段任一变化，Registry 先关闭远端控制面（owner 关闭远端域与 `remote-1` 监听，follower 断开），按新档位重建清单来源后重新打开；工具行卸载工具、校验器、能力投影与 profile 守卫后再按新档位挂载。已登记的远端记录按新清单的绑定摘要判定：摘要不同即 `withheld`，须在面板中重新登记；跨档位从不沿用旧连接。

## 后果

- 个人用户只需在插件详情页打开开关，在 Workspace Folders 面板里添加凭据、环境与绑定即可使用；不需要 root、专用账户或 unit 文件。
- 默认档位不再提供凭据隔离；面板与文档在个人、团队模式下明确标出所接受的风险，硬化模式仍是唯一声称“Agent 拿不到密钥”的档位。
- 修改用户 `~/.ssh/config` 只在用户确认链接时发生一次，且只插入一行 `Include`。

## 被否决的方案

- **为每个连接传 `-F` 或替换 PATH 中的 `ssh`**：上游不暴露这些接缝，改写进程级 PATH 会影响 Host 的其他子进程。
- **直接用密码驱动上游连接**：上游强制 `BatchMode=yes`，OpenSSH 在批处理模式下不调用 askpass。
- **把托管 Host 块直接写进 `~/.ssh/config`**：可行，但每次增删环境都要改用户文件；单行 `Include` 只需改一次且容易撤销。
