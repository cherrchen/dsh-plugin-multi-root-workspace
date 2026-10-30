# Multi-root Skills 上游接缝调研

调研日期：2026-10-23。本文只记录源码事实、原型方法和已知边界；架构选择归 [ADR-0023](../decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md)，任务分解归[实施计划](../plans/completed/2026-10-23-multi-root-skills.md)，执行结果和未覆盖范围只记[路线账本](../plans/active/2026-09-12-multi-root-workspace.md#multi-root-skills-架构验证2026-10-23)。

## 基线与复现方法

上游源码基线为 `dsh-v0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`。以下源码链接固定到该 commit。跨版本集合不另建 allowlist：原型从本仓库 `SUPPORTED_DSH_RELEASES` 读取版本，逐个读取相应 `dsh-v<version>` tag。Git 插件参考为 commit `77d4602579bc2b12a9c72a6a30b80fe79a066969` 的 [Settings 适配](https://github.com/cherrchen/dsh-plugin-git/blob/77d4602579bc2b12a9c72a6a30b80fe79a066969/src/compat/dsh-client-settings.ts) 与 [schema 适配](https://github.com/cherrchen/dsh-plugin-git/blob/77d4602579bc2b12a9c72a6a30b80fe79a066969/src/compat/dsh-schema.ts)。

可重复原型位于 [scripts/probe-multi-root-skills.mjs](../../scripts/probe-multi-root-skills.mjs)：

```sh
# 从本插件目录运行；路径由调用者提供，不依赖固定机器目录。
node --experimental-transform-types scripts/probe-multi-root-skills.mjs --upstream <upstream-checkout>
```

原型通过现有 `scripts/lib/dsh-runtime.mjs` 从 DSH 安装锚点解析发布包，支持既有 `DSH_CLI` 覆盖；不从上游 `/src/` 深导入 Host 实现。UI 纯核单独从传入检出的 TypeScript 运行，因而需要 transform-types。测试只在临时目录创建文件、存储与最小 profile，结束后清理；不会更新主 manifest、lockfile、支持集合或上游检出。运行需要本包已有 `lib/registry.js`，从当前 schema 去掉两个新字段，冻结 Skills 引入前的真实记录形状以复现降级；尚未构建时先按开发工作流构建。

原型内部的 roots Map 和迁移函数是受测模型，不是生产 Registry。原生首步 Catalog、SkillRegistry、FileSystemSkillProvider、工具定义、SessionSkillCatalog、Loader 和 Settings 使用真实发布模块。首次模型步骤通过真实 `agentEvents(...).waterfall('agent/pre-step')` 检查消息，未请求真实 LLM；工具检查执行真实注册的 `skill` 定义，尚不等同于完整 agent-loop journey。

## Session 绑定与缓存

| 接缝 | 已核实事实 | 源码 |
| --- | --- | --- |
| Provider options | 类型仅声明 cwd/signal，但 Registry 原样调用 `provider.list(options)` 与 `provider.get(candidate, options)`；实际参数含公开 SkillViewOptions.scope | [SkillRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts) |
| 首步与工具 | 原生首步 snapshot、显式调用和工具 lookup 均把 Agent 放在 scope，后者等于 exec.agent | [tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/tool-skill/src/index.ts) |
| 可信 Agent | `AgentRegistry.enter` 要求 agent.id 等于 session.id，`get(id)` 返回当前精确 Agent；可以核验 scope 身份，不能仅看对象有 header 就信任 | [AgentRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent/src/index.ts) |
| 原生缓存 | collect key 含 cwd、scope chain 的 WeakMap 身份和 revision；不是单独 cwd。control.invalidate 清空缓存并通知 skills/change | [SkillRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill/src/index.ts) |
| 冷目录 | SessionSkillCatalog 先 observeSession；live Agent 存在时传 Agent，冷会话可能只有 preset key；请求 Session id 不传到 Provider | [SessionSkillCatalog](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/skill-catalog.ts) |
| Registry 挂载 | base 把 SkillRegistry 挂在 Host；web 保留此共享实例，把 filesystem 与 tool-skill 移进 preset 层。因此全局 Provider 能收到实际调用 Agent 的 scope，仍受原生工具可见性约束 | [base](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml)、[web](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/web-app/cordis.patch.yml) |

这些事实允许直接以 live scope 绑定 Origin。需要承认其耦合点：Provider 的窄类型没有 scope，这是对实际借用参数语义的依赖，必须集中在 compat 并保留契约测试；不能把缺失 scope 时按 cwd 猜会话作为 fallback。

## 名称、调用策略与 UI 可见性

Registry 的 `isSkillName` 和 tool-skill 的 execute 都要求 kebab-case。仅把 provider candidate 改成 `repo-a:review` 会在 Registry 校验失败，即使绕过 Registry，工具也拒绝。

原生模型 Catalog 过滤 `modelInvocable`；原生 SessionSkillCatalog Remote 过滤 `userInvocable`；原生显式 `/name` 注入在加载后也检查 userInvocable。因而能给内部候选一个合法 ID、保留模型位、关闭原生用户位，再用单独 Alias 路径依据原始用户位加载。不能把原始用户位直接改掉后丢弃，否则 user-only Skills 会永远无法调用。

原生 tool-skill 先 next，再追加显式 Skill 正文。插件同样可以注册置前 waterfall，在原生 listener 返回后追加别名正文，保持用户原始文本，且无需伪造为原生内部名。解析入口必须只处理本批 source.kind 为 user 的消息。

原生菜单的候选来自 SessionSkillCatalog，其 Client 缓存不会因每一次 skills/change 自动清空：[ui-skill](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-skill/src/client/index.ts) 主要监听 preset/selected、plugin-manager/changed 与 connection/reset。因此自定义命名空间 Source 需要自己的 Session generation 与失效协议。

## Effective CWD 是额外的原生入口

`0.2.1-alpha.2` 起，原生 tool-skill 在 Catalog 与加载时使用 `workingDirectory.ensure(agent)`；更早使用 header.cwd。原生 filesystem Provider 将 cwd 向上找到 Git project root，并扫描该项目下的两条 skill 目录。因此当 effective cwd 进入附加仓库 B，即使插件自己的 Provider 已禁用 B，原生 Provider 仍可能把 B 的 Skills 作为无命名空间名称暴露。

仅检查插件内部 ID 或只过滤 Client 菜单无法解决此问题。原型保留未包装 snapshot 作为负对照，先证明原生裸名存在，再验证公开 snapshot/get 的 Origin 路由对照；冷会话通过公开 SessionSkillCatalog.list 的请求级 Origin 上下文覆盖。此路由不是修改 workingDirectory，也不是修改 Session header。

公开方法包装沿用 [method-wrapper.ts](../../src/method-wrapper.ts)。原型验证实例属性可以恢复，未修改 Registry 私有 collect/cache/provider 表。正式实施还需在真实 generated Gateway 通路、web preset 和 headless composition 验证接缝，不能将直接 Remote 方法调用的原型说成完整网络协议 e2e。

## 文件解析、观察与读取

[FileSystemSkillProvider](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/skill/skill-filesystem/src/index.ts) 从包入口导出。它支持 `includeDefaultRoots: false`、customSkillDirs、watch:false，以及公开 list/get/dispose，足以作为原生 frontmatter 解析委托，不需复制解析器。

它自身并不保证本插件要求的根内读取：

- 发现阶段会读取文件以解析元数据，不能返回后才检查逃逸路径；
- 可用 ctx.fs 时通过 resolve/listDir/stat/readText 读文件；没有 fs 时回退 Node 直接读取；
- get 重新解析文件，可以看见新的调用策略和名称；
- 内部 watcher 的 project LRU 只约束带 projectRoot 的项目根，customSkillDirs 没有该标记；为每根建自带 watcher 的实例不能共享这个预算；
- watcher 管理器没有公共共享注册口，不能拿私有实例当接缝。

因此原型给委托注入根内受限 fs，发现前验证 resolve/listDir，正文用句柄读取并在返回后重验；关闭、移除、身份改变和 generation 改变都丢弃结果。该方法证明普通 symlink 逃逸和读取中撤销可被拦截，不证明任意恶意祖先 rename 下的原子快照，也没有实测 Windows reparse-point 的内核细节。原生发现会解析读取全文，但只把元数据交给 Catalog；“按需正文”指正文进入模型上下文的时机，不意味着发现阶段只读文件头。

生产观察池的轮询区分根身份与 Skills 内容：根只记录 canonical 路径、文件身份和权限；Skills 目录/文件继续记录内容相关元数据。普通根文件的增删不应改变 Skills generation，否则轮询与显式调用加载交错时会丢弃无变化的正文。根消失/替换、Skills 增删改和登记撤权仍使旧结果失效；回归分别覆盖这些交错，不以延迟轮询或重试掩盖问题。

## Settings 与 Web 接缝差异

下面是审查集合中的形状分组，不是第二份支持名单；新版本仍以 allowlist 与接缝探测为准。

| 源码分组 | Settings 数据面 | 全局设置展示面 | 已发送引用 |
| --- | --- | --- | --- |
| `0.1.5-rc.2`、`0.1.6-alpha.1` | settings.installSection / namespace scope，普通 Config 值 | settings.plugin.item | 无 UserTextRule，保留原文 |
| `0.1.6-alpha.2` | 同上 | plugins.bundle.config，以包名为卡片 key | 无 UserTextRule，保留原文 |
| `0.1.7-alpha.1` 至 `0.2.1-alpha.2` | volatile Config，表单 namespace = loader entry id | plugins.bundle.config + configForms | 无 UserTextRule，保留原文 |
| `0.2.1-alpha.3` 至 `0.2.1-rc.2` | 同上 | 同上 | 有 UserTextRule 与 keyed Renderer |

modern Settings 只投影 volatile 字段；把 enabled 写成普通 boolean Config 会导致表单不暴露。字段值是稳定引用，必须每次读取 get()，不能把对象当 boolean。旧 installSection 提供 setSource/onChange 与 namespace watch，可以在关闭和恢复时通知失效。

[SettingsForms](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/settings/settings/src/index.ts) 按 loader entry id 描述/修改字段；[插件管理页](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx) 的 plugins.bundle.config 却按 pkg.name 选卡片。这两种 key 可以不同，多行 bundle 无须伪装成单一 Host 行。

实际 [Slash Trigger](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-input-trigger/src/core/detect.ts) 扫到空白前保留冒号，[草稿扫描器](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/input/decorations.ts) 不识别完整冒号引用。新宿主的 [UserTextDocument](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/conversation/user-text-document.ts) 可以接收自定义语法 matcher；节点 Renderer 可独立展示完整引用，语法匹配不提供调用授权。按 [ADR-0023 的 Web 范围](../decisions/ADR-0023-multi-root-skill-discovery-and-invocation.md#5-web-ui-范围)修订，当前 Renderer 只返回普通文字，不注入点击预览回调。

## 迁移与已加载正文

[Registry schema](../../src/registry.ts) 继续使用 domain v1，新实现保留 Skills metadata；引入 Skills 前的记录 schema 会剥离这些未知字段。原型将当前 schema 冻结为旧记录形状，把含 aliasId/skillsEnabled:false 的新记录交给它，再重新执行迁移，能观察到字段丢失和 inherit 默认重新开启。生产回归另经真实 JSON 存储重新打开验证重迁移。这是降级写回的已知行为，不能以 v1 可读推导配置无损。

当前原生 Skill 加载的结果是工具返回值或 instructions-form 用户上下文，没有插件能统一回收的“Skill 正在执行”句柄。原生 tool-skill 持久 Catalog 会记录 entry digest，变化时发送替换目录，变为空也会显式停用旧名称；已投递正文依然在会话历史中。禁用保证应针对后续发现与加载，不能承诺删除既有文本或结束其后已启动的工具进程。
