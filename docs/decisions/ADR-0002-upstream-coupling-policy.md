# ADR-0002: 上游耦合策略（入口导入、精确 pin、升级 smoke）

## Status

Accepted（决策 4 的后半句与决策 6 已被 [ADR-0009](./ADR-0009-dsh-compat-contract.md) 取代，见下方标注）

## Date

2026-09-12（2026-09-15 修订）

## Context

本插件通过“disable 上游 provider 行 + insert 自己的子类”实现多根，这使它成为上游 pre-stable 代码的直接依赖方：子类继承上游类，patch 依赖上游行 id，运行时依赖上游 service key 与类型契约。上游明确不承诺 semver 兼容。

实现前实测得到三条会直接影响设计的事实：

1. **发布包不含源码**：`@deepseek-ai/dsh-fs-sandbox@0.1.5-rc.2` 的 tarball 只有 8 个文件（`lib/index.js`、`lib/types/*.d.ts`、README、LICENSE、`package.json`），没有 `src/` 目录；虽然 `package.json.exports` 声明了 `"./src/*"`，但在安装形态下该映射指向不存在的文件。本机 profile 中带 `src/` 的副本来自“指向应用内副本的符号链接”，不是发布形态。因此 `fs-sandbox/src/containment.ts`（`isPathUnder`）与 `sandbox-local/src/profiles.ts`（方言 builder）都不可引用。
2. **dist-tag 不可信**：`@deepseek-ai/dsh-*` 的 `latest` 指向陈旧的 `0.0.1-rc.1`，真正的新版在 `next`（`0.1.5-rc.2`）；已安装桌面运行时是 `0.1.2-rc.1`。使用范围或 `latest` 会装到错误的版本。
3. **两运行时语义高度一致**：`fs-sandbox`（`index.ts`、`containment.ts`）、`sandbox/roots.ts`、`sandbox-policy`、`terminal-bash` 在 `0.1.2-rc.1` 与 `0.1.5-rc.2` 之间逐字节相同；差异集中在 landlock 导入路径、`bash-local` / `bash-sandbox` 的内部表述与参数名、以及 `fs-local` 新增的 `readByteRange`。

同时，插件与宿主必须共享同一份 cordis 与服务定义包：cordis 的 `Service` 身份与 service 注册机制依赖模块实例唯一性，双副本会导致注册行为不可预期。

## Decision

1. **只允许包入口导入**。禁止引用任何 `pkg/src/*` 路径（无论本机是否能解析成功）；需要上游内部实现时，按“本地实现 + 文件头注明来源 commit 与复制范围 + 差分测试钉住”的方式落地（首个案例：`isPathUnder`）。
2. **多根方言 grant 不调用上游 builder**（发布形态不可达，且 landlock 导入路径已在版本间变化）。实现方式改为从 `super.confine` 的输出中识别并克隆 grant 模板；识别失败时抛错而不是静默按单根执行。
3. **运行时依赖声明为 peerDependencies**（`@deepseek-ai/cordis`、`dsh-fs`、`dsh-fs-local`、`dsh-sandbox`、`dsh-sandbox-local`、`dsh-sandbox-policy`），由宿主提供单一份实例；插件不打包、不自带这些包的副本。
4. **精确 pin 开发/CI 版本**：`devDependencies` 固定一个确切版本（当时是 `0.1.5-rc.2`，对应上游 checkout master `c291e7961a`，也是 registry 的 `next`），不使用 `latest` 或宽范围。~~`peerDependencies` 采用生态惯例范围以兼容已安装运行时~~ —— **已被 [ADR-0009](./ADR-0009-dsh-compat-contract.md) 取代**：范围声明承诺的兼容面远大于实际验证过的面，现在 `peerDependencies` 只列 allowlist 里的确切版本。
5. **建立升级门禁**：以“差分 parity 套件 + 组合 dump 差分断言 + 空根行为冒烟”作为升级 smoke；改动 pin 后必须重跑，任一差异即报警。父类只允许使用上游公开方法面（不触碰 TS-private、不做原型替换）。
6. ~~**双运行时矩阵**：`0.1.5-rc.2`（上游 checkout 构建产物）与 `0.1.2-rc.1`（已安装桌面运行时）都必须通过空根冒烟，差异按上文第 3 条清单核对。~~ —— **已被 [ADR-0009](./ADR-0009-dsh-compat-contract.md) 取代**：矩阵不再由"宿主恰好装着什么"定义，而是等于 `SUPPORTED_DSH_RELEASES`；`0.1.2-rc.1` 从未跑完整套件，因此不在其中，装在它上面的插件现在会整体不启动。

## Alternatives Considered

| 方案 | 否决理由 |
| --- | --- |
| 深导入 `pkg/src/*` 复用上游内部实现 | 发布形态不存在该文件；本机可解析属环境偶然（符号链接），CI 与发布形态会失败 |
| 把 dsh 包作为 `dependencies` 自带副本 | 会产生第二份 cordis 与服务定义实例，破坏 service 身份；且插件会与宿主版本漂移 |
| 使用 `^0.1` 之类的范围依赖 + 自动升级 | `latest` 指向 `0.0.1-rc.1`，范围解析会得到错误版本；上游无 semver 承诺，自动升级等于把安全语义交给不确定性 |
| 只用单元测试，不建差分套件 | 本地实现与上游行为一旦漂移，只有差分对照能发现；单测只能证明“符合我们自己的预期” |
| 依赖上游测试套件保证一致性 | 上游测试不覆盖“被外部子类替换后”的组合，也不会在插件仓库运行 |

## Consequences

- 正面：插件的失败模式可预期——要么在装配期 fail loud（行未生效、方言不可识别），要么在升级 smoke 中被差分测试捕获；不会出现“安装形态才炸”的深导入问题。
- 代价：`isPathUnder` 与（M2 的）方言 grant 拼接属于对上游行为的本地复刻，需要持续维护；上游一旦改动 fence 细节，必须由差分套件发现并同步。
- 代价：精确 pin 意味着每次上游发版都要人工决定是否升级，并跑一遍升级 smoke。
- 代价：方言 grant 采用“模板克隆”而非调用 builder，实现上更依赖对 argv 形状的识别；因此必须保留“识别失败即抛错”的兜底，不允许降级为单根静默执行。

## Related Documents

- [ADR-0001：只替换两个 provider 行](./ADR-0001-provider-replacement-scope.md)
- [ADR-0009：DSH 兼容性代码契约](./ADR-0009-dsh-compat-contract.md)（取代决策 4 的 peer 范围与决策 6 的运行时矩阵）
- [架构设计：Multi-root Workspace](../architecture/multi-root-workspace.md)
- [上游调研：Workspace / Sandbox / 插件体系](../reference/multi-root-workspace-research.md)
- [M1 开发计划](../plans/completed/2026-09-12-m1-composition-and-passthrough.md)
