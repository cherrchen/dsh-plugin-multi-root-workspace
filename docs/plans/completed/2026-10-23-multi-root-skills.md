# Multi-root Skills 实施计划

## Goal

实施 [ADR-0023](../../decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md)：附加根 Skill 的首步发现、命名空间调用、独立 Root 开关和插件详情全局配置。架构已接受，生产实现已落地，S1–S7 全部完成并随 `v0.1.10` 发版；实施证据与能力边界见[路线账本](../active/2026-09-12-multi-root-workspace.md#multi-root-skills-架构验证2026-10-23)。

## Background

需求源于 [Issue #17](https://github.com/cherrchen/dsh-plugin-multi-root-workspace/issues/17)。已核实的上游 API、版本差异与复现入口见[接缝调研](../../reference/multi-root-skills-seams.md)。本计划只规定落地顺序与退出条件，不复制 ADR 的产品规则。原型保留在 `scripts/probe-multi-root-skills.mjs`，不能直接当生产实现或最终回归套件。

## Current State

实施前基线中，Registry、命令和 Dialog 没有 aliasId/skillsEnabled，patch、exports 与 Client 中也没有 Skills 行、命名空间菜单、读端点或 Settings 卡片。现有生产实现已接入这些入口，并增加正式 Registry/lease、Connection、观察调度器、平台文件系统回归和 web/headless journey；它们是验收对象。原型的 roots Map、迁移函数与临时 profile 仅保留为架构参考，不能替代生产回归。兼容集合保持原样不变；本功能随 `v0.1.10` 发版。

## Scope / Non-goals

范围是下列 S1–S7，最终验收对应 ADR 的 A1–A13。第一阶段不修改上游包、不重写原生 YAML/frontmatter 解析或 Skill 执行系统，不实现草稿原生高亮、不扩张文件写权限、不回收历史正文或已启动进程。旧宿主缺少 UserTextRule 时保留已发送原文，仍须提供补全、完整插入与 Host 显式调用。

## Design

单一 Registry → Origin / Root Skills 投影 → 单一聚合 SkillProvider + 受限原生文件解析委托。模型用合法内部 ID，经原生 skill 工具加载；用户用 aliasId 命名空间，由 Host pre-step 解析。公开 Registry / 冷目录包装封住 native Effective CWD 旁路。Settings 仅控制 Skills Config；Root metadata 仍在现有 storage domain。

建议文件边界：`src/skills.ts` 作为可选 Host 入口；纯 metadata/命名和扫描、加载、观察核心可拆在 `src/skills/`；版本接缝仅在 `src/compat/`；Client 使用既有样式/locale/channel 结构。不要把可选 Skill 运行时静态 re-export 到 carrier barrel。

## Implementation

### S1 — 固化兼容接缝与运行时装配

依赖：无；先于所有功能批次。

- 将原型中的关键行为转换成可在正式版本矩阵运行的契约测试：借用 options.scope、scope cache key、原生 invocation 过滤、公开 FileSystemSkillProvider、Settings 形状与冷目录入口。
- 新增 Host entry、包 exports 与 `multi-root-skills` patch 行，enabled 默认 true；注入 multiRootCompat、provider brand、Registry/Scope 及必要原生服务；可选 Web Settings、SessionQuery、冷目录包装通过子 fiber 安装。
- 按真正执行副本为 skill、skill-filesystem、相关宿主服务补充 optional peers、开发 pin 与兼容分类；缺少可选能力与包求值失败分开，不增加第二个支持版本列表。
- 明确服务缺席、foreign provider、门禁拒载与最小组合行为，保留基础 fs/sandbox 行的既有退化机制。

退出条件：所有原有支持版本的相关契约可执行；可选依赖不被 carrier 求值；没有根时不贡献任何 Skill 或改变上游查询参数。只有装配与契约通过，才接入生产数据。

### S2 — Registry metadata、迁移与根管理契约

依赖：S1。

- 在 domain v1 的现有单条 Root 记录新增 aliasId、skillsEnabled；schema 必须继续使用 storage-domain 自己解析的 zod。区分缺失与非法 metadata；非法 Skills 字段不得被当成旧记录默认启用，也不借迁移修复/重授 grant。
- authority domain open 后，在现有有序队列中迁移旧记录；先持久化，再发布新 Skills 投影。写失败不给新增能力，contended 进程不迁移；refresh 仍无写。
- 实现 ADR 的稳定 aliasId 分配、编辑校验与在册唯一性，新增 Root、实际 access 变化与 revive 的开关规则；同值 setAccess 保留手动选择。
- 扩展 RootStatus / RootsView 与 `src/contract.ts` 的 endpoint → response 映射，为命令/面板提供相同的 metadata mutation。保留 Session-derived authority 和一个串行 mutation 写路径。
- 修改 Workspace Folders Dialog，显示并编辑每根 Skills/aliasId；增加清晰的命令支持及帮助。命令采用 `skills <n|path> on|off` 与 `alias-id <n|path> <kebab-case>`，同步双端验证。

退出条件：A1/A2/A4/A10 的生产 Registry 测试通过，覆盖真实 JSON 栈、重启、并发、contended/takeover、迁移写失败、重复加载、同名空名、非法 metadata 与降级写回。grant 三键与 writableRoots 不被 metadata 修改；旧数据在全局关闭时仍能一致迁移。

### S3 — Session 发现与 native Effective CWD 路由

依赖：S1、S2。

- 聚合 Provider 读取 options.scope，经当前 Agent 精确身份取 header Origin；首步发现必须 await 完成，不能依赖 touch 或后续 working_directories。
- 复用 FileSystemSkillProvider：指定两个目录，includeDefaultRoots:false、watch:false，按 ADR 去重。注入受根边界约束的 fs 读面，候选读取前就拒绝逃逸。
- 以 `wrapMethod` 包装原生 snapshot/get，把落在在册附加根内的 cwd 归回 Origin；同时检查词法与 canonical cwd，缺失/redirected/关闭记录不能从路由判断消失。
- 给 native SessionSkillCatalog.list 装请求级 Origin 上下文，覆盖冷 preset scope；自有 Client 读端点通过 SessionQuery，不伪造 Agent。
- 不假定注册顺序：验证服务晚到、preset 重组、插件 reload 和卸载；保持 caller receiver、signal 与原始属性描述符。

退出条件：A5/A6/A13；真实 web preset 与 headless 均验证首步；两个 Origin 共享 cwd、子 Agent、resume、cold Session、未知 Session 和 cwd symlink 不串扰。保留原生未包装负对照，以证明新路由确实封住裸名发现；主根 Skills 在全局关闭时可用。

### S4 — 按需加载、用户 Alias 与撤销

依赖：S3。

- 按 ADR 生成内部 ID，以最低优先级注册，原生用户位关闭、模型位保留，真实 invocation 策略单独保留；精确 ID 与外部贡献冲突时诊断，不能覆盖 winner。
- 原生 skill 工具继续加载模型条目；Host 注册置前 pre-step Alias Resolver，只扫描本批用户消息，按稳定 Root 身份定位，正文在 native Catalog 返回后追加，保留用户原文。
- 每次加载和预览重验开关、authority、scope、Root/文件身份及新解析的 name/invocation。读取后再检查 generation 与取消，不提交撤销中的旧结果。多 Skill 调用须在整批返回前重验全部加载凭据并同步核对 generation，获准后才更新投递跟踪；不能只在逐个加载后检查。
- 已知关闭返回权威空贡献并失效原生缓存；验证 Catalog 替换为空、旧内部 ID、旧 Alias、用户手输与模型重放均不能新加载。独立处理原生其他 Provider incomplete 时本功能的撤销通知。
- 消息 source 经 compat 适配 format 3/4；不使用 native agent-instructions producer，不提升到 systemPrompt。明确已加载正文与已启动进程的边界。

退出条件：A3/A7/A8；真实 native tool dispatch 与 pre-step 测试通过，user-only/model-only/default 两策略组合覆盖，延迟 list/get/read 下关闭、权限变化、移除、重定向、名称/策略变更和取消均有回归。

### S5 — 统一观察、Host/Client generation 与 RPC

依赖：S3/S4 的发现和加载接口；先完成后再接 UI 缓存。

- 用现有 Connection RPC 扩展 Skills list/preview 与 generation 查询/订阅能力，单一 contract 声明请求响应；读端点接受 Session id，通过可信 observation 取 Origin，不接受客户端 primaryRoot 或路径作为 authority。
- 实现共享观察调度器和 LRU 委托池，按 ADR 限额；原生委托不启动 watcher。文件新增/删除、根 missing/redirected、Registry/Config 修改、authority 切换驱动 generation 与 control.invalidate。
- 每次请求边界重验，预算外根仍可发现；缓存完成后再比较 generation。Client 切 Session、断线、重载、关闭开关时 abort 在途请求，旧包不得覆盖新目录。
- 卸载先关闭准入，再取消/排空读取与观察，释放委托、订阅和方法包装；不能把异步 dispose 交给无人 await 的回调。

退出条件：A8/A9 的真实文件变化与并发测试通过；证明观察根去重、容量上限、淘汰和重复启停无资源增长，并测量扫描与响应成本。用实际 Connection 通道验证旧响应丢弃，不只测试本地 Map。

### S6 — Web Slash、普通文字引用与插件设置

依赖：S2、S4、S5。

- 独立 InputTriggerSource 列出 `/aliasId:skillName`，提供 `/repo-a:` 查询与完整插入；菜单以每次调用的 Session id 取目录。只按原始 userInvocable 列出，不泄漏 internal ID。
- 按 ADR-0023 的 2026-10-24 修订，新宿主探测 uiConversation.userText 与 keyed Renderer 后完整匹配命名空间引用，仅返回普通文字；旧宿主保留原文。不添加背景或高亮，不提供点击弹窗；补全与调用保留。受检预览 RPC 保留，不接聊天点击入口。
- Settings modern Config 用 volatile enabled 并在每次准入读取；legacy installSection 用 namespace + onChange；Client 双形状配置表单映射到正确行；包级卡片只注册一次。
- 全局关闭/恢复实时失效 Host 和所有已打开 Session 的 Client Catalog；Workspace Folders Dialog 不增加第二份全局开关。Settings provider 消失/恢复、旧卡片与新卡片不重复注册。
- 所有新 UI 文案中英文同步，沿用单一 styles.ts 与宿主颜色 token。

退出条件：A11/A12 的 DOM 和真实浏览器检查通过；最早 legacy、0.1.6-alpha.2 卡片形状、modern Config 和 UserTextRule 形状均有回归。分别验证 Root 关闭、全局关闭、恢复和两会话切换；已发送展示不得误称 Skill 已执行。

### S7 — 完整矩阵、文档与发布准备

依赖：S1–S6。

- 将原型中的成功路径与负对照收敛到生产测试；原型继续作为架构参考，不以其结果取代 journey。
- 新增真实 agent-loop journey：首请求仅目录、模型按需调用、用户命名空间调用、进入附加根后禁用不走 native 裸名、运行中修改配置与恢复；web/headless 两组合。
- 所有支持的精确版本 × 已启用 OS 执行既有 mandatory gates。每个平台如实记录 symlink/junction、读取句柄、路径大小写、观察与原生沙箱结果，不把本机 macOS 原型扩大为全平台通过。
- 运行既有 compat、lint、typecheck、build、kernel:probe、test、三项 smoke、pack:check、smoke:packed、docs:check，并保留现有 Auto Review 联合回归。
- 更新用户指南、命令与配置参考、双语 README；发布前更新双语 CHANGELOG，明确旧 inherit/read-write 默认启用、关闭方式和 metadata 无损降级不受保证。发布版本与 tag 按既有 release workflow，不在本计划预先承诺版本号。

退出条件：ADR A1–A13 全部有可复现证据、必要平台执行无悬空项，打包安装通过，现有功能回归通过。完成后迁移本计划到 completed 并同步中英文索引；状态仍只在路线账本记账。

## Validation

S1 → S2 → S3 → S4 → S5 → S6 → S7 是依赖顺序。每批完成相应退出条件后推进；原生 API 形状无法维持时先修 compat，不能以跳过旧版、扩大 warn 或允许裸命令换取通过。架构若需改变，则修订 ADR 并说明新证据。

Windows 的平台退出条件包含两项本机可能缺少前提的原生 ACL 用例：第二固定卷授权必须证明主根与跨卷附加根可写、第三目录拒写；foreign-owner 必须先读回 SYSTEM 属主与 Everyone deny ACE，再证明启动前拒绝或受限子进程的两处写入均被拒绝。CI 缺少这些前提应失败，不能按本机能力规则跳过。检查日志时须区分这两例与其他平台/宿主能力跳过，并绑定实际受检 SHA、run attempt 与任务链接；矩阵任务、最终 gate 和可选 Auto Review 的合同范围分别记账，不能仅凭已完成的部分任务称全矩阵通过。执行结果仍只记路线账本。

## Risks

- 借用 scope options 与 native 冷目录包装是公开方法行为耦合，升版时必须重新验证。
- native 发现随 cwd 的旁路是安全关键路径；只做自定义菜单会漏掉它。
- 旧 schema 写回丢失 metadata 是已知边界，迁移不能宣称恢复用户曾经手动关闭的意图。
- 文件句柄与前后检查不能提供对任意祖先 rename 的原子事务；Windows reparse-point 和网络路径边界必须在对应平台验证。
- 观察预算之外按需扫描有性能成本，真实 UI 订阅、cold reads 与完整安装路径仍需实现验证。

## Documentation Impact / Completion Criteria

ADR 为行为与架构真源，reference 为源码事实真源，本计划为任务与退出条件真源，路线账本为进度与验证真源，CHANGELOG 为发布内容真源。只有 S7 退出条件满足才标记功能完成；Accepted ADR 本身不等于已发布支持。
