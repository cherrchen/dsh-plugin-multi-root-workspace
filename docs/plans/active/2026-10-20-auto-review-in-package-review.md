# Auto Review 并入主包：需求评审

> 状态：迁移实施中。日期：2026-10-20。下文保留实施前的需求评审；选定方案见 [ADR-0022](../../decisions/ADR-0022-auto-review-loader-entry.md)，它取代 ADR-0021 的交付结构，保留上下文与安全合同。实施及验证进度只见[路线账本](./2026-09-12-multi-root-workspace.md#auto-review-内置入口迁移2026-10-20)。

## 结论

取消独立包名、迁入主包子路径、默认关闭、在现有插件管理器中提供一个行开关，以及退役 companion 安装与排序流程，均有明确的实现路径。

**不能按需求给出的实现手法直接承诺全部语义成立。** “fork 的 apply 内扫描 sibling，设置 disabled 后 remove”只是一次性接管：当前 loader 的并发导入和 profile reload 都能使官方行再次尝试启动。已经用真实 loader 与模拟 owner 复现这两个问题。没有第二个 companion bundle 可以消除其排序要求，但不消除官方 bundle 的存在、并发启动、异步卸载和重新组合的时序。

建议按“有条件可行”进入开发：先验证持续接管与恢复原型，再进行包迁移；原型若不能在不修改上游的约束下通过，必须调整接管语义或扩展上游生命周期接缝，不能把迁移文件和首次启动成功作为完整交付。

## 评审基线

- 本仓库 HEAD `ccc7d05`，主包与 companion manifest 均为 `0.1.8`；评审开始时工作树干净。
- 上游本地源码 HEAD `687f282e8625c6b8d11ff58211a90524be2e4317`（`dsh-v0.2.1-rc.2`）。
- 实际安装树：DSH `0.2.1-rc.2`、Cordis `4.0.5`、`cordis-plugin-loader` `1.0.6`、`cordis-plugin-include` `1.0.10`；Node `24.18.0`。
- 证据来自当前仓库、上述上游源码和本机安装产物。本次未运行完整 Auto Review 联合 smoke、浏览器 UI 操作或多 OS/旧版本矩阵；不将最小 loader 验证称为完整产品验收。

## 逐项判定

| 需求 | 判定 | 必须补齐的边界 |
| --- | --- | --- |
| 移入 `src/auto-review/`，导出 `./auto-review` → `lib/auto-review.js` | 可实现 | 显式命名构建入口、声明文件及发布清单；同步 fork provenance、MIT、差分门禁和测试路径 |
| 普通安装默认不启动，零挂载 | 可实现，但需精确定义 | loader 保留可展示的 disabled entry；零挂载指不运行 reviewer/context、不注册 Auto、不安装接管 hook，而非不存在 entry 元数据或包体积不变 |
| 插件管理器行开关，出厂 `disabled: true` | `0.2.1-rc.2` 有现成支持 | 稳定且唯一的 patch id；普通非 group 行；管理器/热重载能力由 profile 提供，没有 HMR 时保存后重启生效 |
| 启用后替代官方，不依赖两 bundle 的排序 | 目标可行，一次性 `apply` 手法不足 | 覆盖并发导入、后出现/重新启用的官方行、每轮 reload、旧 owner 完全退出和失败收尾；最终接缝需原型验证 |
| 关闭后官方随 reload 复活 | 有条件成立 | 官方 bundle 仍被选择，官方行原配置允许启动；不能覆盖用户原有 disabled 决策；同轮 reload 的停止/启动仍需串行交接 |
| 删除 configure、独立 tarball、bundles 追加与排序 | 可实现 | 更新 smoke、release、compat、upgrade、workspace/lockfile；原先已安装的 companion 另需迁移处置 |
| 保持 `multiRootCompat` inject + `assertAutoReviewRelease` | 保持安全语义可实现 | 主包普通支持矩阵不收窄；Auto 仍仅接受 `0.2.1-rc.2`；精确执行副本检查不能随独立包消失 |

## 当前实现核对

迁移前现状描述的核心准确：原 companion patch 先按 id 禁用官方 `auto-review`，再插入 context 和 required fork；原 configure 要求已选择官方和主包，并把 companion 排到 bundles 末尾（原实现见 commit `ccc7d05` 的 `compat/auto-review/cordis.patch.yml` 与 `configure.mjs`）。Include patch 只能命中处理到该 patch 时已存在的行，因此这一排序是当时的真实契约。这两份实现已在本次迁移中退役。

但“之前启用官方后不自动启动”只能说与这条装配限制一致；本次没有那次实际 profile、日志和开关操作记录，不能据此唯一归因。当前 smoke 在测试不同初始排序后仍运行 configure 纠正顺序，并未证明任意原始排序都可直接接管。

## 阻止直接通过评审的问题

### 1. 一次性接管不覆盖并发导入和 reload

实际安装的 loader 行为：

- `EntryGroup.update()` 以 `Promise.all` 创建/更新同组 entries，不按数组顺序等待各行完成。
- `Entry._init()` 等待模块 import 后直接创建 fiber，没有在 import 返回后重新判断 disabled 或是否已从 store 移除。
- `EntryGroup.remove()` 调用 `fiber?.dispose()` 后从 store 删除，返回值不代表异步卸载完成。
- Include 每次更新从原始数据与新 patches 重新组成 entries。被运行时 remove 的官方行仍在 bundle 原始定义中，下次会重建。
- options 未变且已有 fiber 的 fork entry 可以保持运行，不会因其他行重建而重新执行 apply。

本机最小验证使用真实 `Context` / loader，以两个模拟插件争用一个 owner 来隔离生命周期，未调用模型或真实 `registerAuto`。fork 已经先设置官方 `options.disabled = true`、调用 `parent.remove()`，并等待捕获到的官方 fiber 结束。结果：

| 场景 | 实测轨迹 | 说明 |
| --- | --- | --- |
| 首次成功接管，再以同样配置 `root.update()` | 官方取得 owner → 官方释放 → fork 取得；reload 后官方再次向 fork 占用的 owner 注册；fork apply 总次数仍为 1 | 一次性接管不覆盖 reload |
| 官方模块 import 人为延迟 20 ms | fork 取得 owner → 已移除官方 entry 的 import 完成，官方仍尝试注册；store 中只有 fork | remove 不取消尚在进行的 import，不能仅检查最终 entry 列表 |

复现步骤是：挂载 Loader；将该测试树的 `import` 替换为返回上述两个模拟插件的函数；`root.update([{id:'official',name:'official'},{id:'fork',name:'fork'}])` 后 `loader.await()`；第一场景重复 update，第二场景延迟 official import。owner 通过 `ctx.effect` 注册、在 disposer 释放，重复注册抛错。此验证只改变进程内夹具，没有修改上游包。

真实官方 `permissionPresets.registerAuto()` 遇到重复 owner 会抛错。这些轨迹证明的是冲突/失败风险，不是两个 owner 已经同时成功注册。官方还会安装审查 listener，因此不能把“重复注册最终被拒绝”当作完整的互斥方案。

接管必须是覆盖整个启用期的生命周期协调：预检 → 阻止官方新启动 → 停止旧官方并等待 drain → 注册 fork → 持续覆盖后续重组 → fork 退出并 drain → 按原配置恢复官方。应通过原型选定可用的 loader 接缝；不能仅在 `app-boot/config-reload` 通知后清理，因为那时启动冲突可能已经发生。

### 2. review-context 不能成为第二个人工开关

当前 fork 的 inject 包含 `multiRootReviewContext`，而主包 patch 不挂载它。直接新增一条 disabled fork 行，打开后只会等待缺失服务，apply 不会执行；把 context 无条件加到主包 patch 又违背默认零挂载。

建议验证一个公开 loader 入口拥有整个可选集成：先满足 compat/provider/基础服务并检查精确 release，再按该入口的 lifetime 挂载 context、协调接管并挂载 fork。入口自身不能先硬注入尚待自己创建的 context。关闭时逆序拆除，保留现有 review 取消和 drain，所有内部挂载都受同一个开关支配。

这是拟议结构，不是已通过验证的实现。`src/index.ts` 不得通过值 re-export 牵入 fork；可选 peer 不能因此进入默认 carrier 的加载链。

### 3. remove 必须区分运行时操作与持久配置操作

loader 的 `tree.remove()` 会调用 tree write；`entry.parent.remove()` 本身不 write。直接 dispose 一个仍被视为 enabled 的 entry 时，loader 的内部监听也可能将它标记为 disabled 并写回。上游 app-boot 在需要临时停止行时明确采用先标记 disabled、再 parent.remove 的方式。

因此必须验收：接管不修改官方用户配置、不把组合后的整份配置写入文件；关闭并 reload 后只恢复原本应启用的官方行。运行时 remove 还会让该行离开 inventory，UI 中官方 loader 行可能暂时消失；产品文案应明确这一表现，不能声称它只是稳定保留在列表中的“关闭”开关。

### 4. 主包多版本构建会失去原先的物理隔离

当前 `build-auto-review.mjs` 仅在 dev pin 为 `0.2.1-rc.2` 时编译 companion；Vitest 同样按 pin 选择其测试；upgrade 脚本在其他版本将 companion 从 workspace 移除。迁入 `src/auto-review/` 后，host 的 `src/**/*.ts` 会自动纳入它，旧版可能在运行时门禁之前先发生类型或依赖失败。

应保留独立编译边界或提供足够的类型适配，并保证所有普通支持版本的 build、typecheck、pack 检查仍有定义一致的产物。不能在旧版静默省略 manifest 已导出的 JS/types 文件；不能将整个主包 peers 缩成 Auto 的单一版本。

fork 当前从运行时值导入 llm、tools、permission-presets、util-values。后两者不在主包现有直接 manifest 中，需重新安排 optional peer/依赖及 external 策略；不能无意内联服务身份，也不能让普通旧版安装自动拉入一棵 `rc.2` 运行树。tools 当前在普通 compat 中作为 host-service 取证，fork 却会执行其副本；需要按启用路径复核取证锚点，保留 `assertForkPackages()` 的精确执行副本检查，不能只是保留 release 字符串判断。

### 5. owner 切换会改变存活 Session 的权限 preset

官方与现有 fork 的卸载逻辑都将 Auto Session 迁移到 Full access，然后取消并等待在途 review。故 live 启用 fork、关闭 fork、reload 导致 owner 更换，都不能承诺 Session 继续保持 Auto；新 owner 出现不会自动重新选择 Auto。若“完全接管”包含无感保持 Auto，那是另一项行为变更，不能归入本次纯迁移。

没有 HMR 的 profile 则不能承诺点开关立即生效：现有管理器会保存配置并返回 restart-required。应沿用这个产品行为。

### 6. 旧 companion 配置需要明确升级路径

仓库账本记录 companion 尚未发布，不等于没有通过本地 tarball/link 安装的 profile。原依赖、bundle 选择、旧 owner 和可能已有的 profile patch 不会因新主包少一个 workspace 自动消失。

迁移可以移除 configure，但需提供一次性清理旧依赖/bundle 的步骤或有边界的迁移措施；遇到旧 companion 仍启用时必须明确诊断或协调，不能只识别官方包名而遗漏第三个 owner。不应在新 fork apply 中隐式重写用户 manifest。

## 建议修订的需求合同

1. 主包提供 `./auto-review` loader 入口，固定 id，默认 disabled；既有主包功能与普通支持集合保持不变。
2. 默认只存在可展示的 entry 元数据，不加载 fork、不挂载 context、不注册 Auto、不安装接管监听。
3. 单一行开关管理 context、接管器和 reviewer；只有版本、执行副本与必需服务全部通过后才进行接管。
4. 在共同 profile 组合内，官方 bundle 位于主包前后都有效；Auto 入口启用期间，冷启动、重新组合和官方后加入/重新启用都维持唯一可用 reviewer，且没有遗漏的 listener/fiber。
5. 接管只改变运行时状态，不持久禁用官方；关闭后经支持的 reload/restart 生命周期，按用户原有官方配置恢复。官方未选择或被用户禁用时不强行启用。
6. 缺失服务、门禁拒绝、启动失败与卸载中的处理必须明确，不能显示接管成功而实际继续用未补上下文的官方 reviewer；不可产生未被保护的自动回退窗口。
7. 保留官方及当前 fork 的 Auto → Full access 卸载语义；不自动把 Session 切回 Auto。无 HMR 时遵从 restart-required。
8. 退役独立包与安装排序机制，保留 fork provenance、MIT、精确版本/执行副本门禁和全部有意义的联合回归，补齐旧 profile 迁移说明。

## 实施前置验证与验收

先完成真实 loader 的生命周期原型，再进行迁移。至少覆盖：

| 验收组 | 必测场景 |
| --- | --- |
| 默认关闭 | 普通最小组合、完整组合和所有支持版本；无 Auto/context/hook；carrier 不解析新增可选依赖 |
| UI 单开关 | 默认可见但关闭、打开、关闭、重启保留；有/无 HMR；唯一可寻址 patch id；无需第二个 context 开关 |
| 互斥 | 两 bundle 顺序、官方先运行、官方延迟 import、fork 先运行、官方后加入/重新启用、无关配置 reload、连续多次 reload |
| 退出与失败 | 在途 reviewer、人工审批等待、官方/fork 异步 drain、快速开关、缺服务/混装/错误版本、接管中失败、provider 消失和恢复 |
| 恢复 | 官方原本启用/禁用/未选择；完整重启及热 reload；配置文件无运行时接管引起的持久写入；Session 不自动重选 Auto |
| 制品与旧安装 | 单一 tarball 的全部 exports/default/types、prepare/git 构建、包外真实安装；旧 companion 残留诊断与迁移 |
| 安全回归 | 原 fork 差分、native/PTC、freshness/token、约束身份、只读围栏；主包既有完整矩阵与各 OS 必需 gates |

迁移将涉及 manifest/exports、构建与 types、主 patch、fork/测试路径、fork 校验脚本、联合 source/packed smoke、compat/upgrade/release 脚本、workspace 与 lockfile。文档需新增或修订交付决策，保留 ADR-0021 历史，更新双语使用说明和相关入站链接；版本发布内容仍只进入 CHANGELOG。上述工作属于后续实施范围，本次未执行。
