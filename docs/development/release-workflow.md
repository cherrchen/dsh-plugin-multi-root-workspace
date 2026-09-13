# 发版流程（Release Workflow）

本文档描述从版本号变更到 npm 发布与 GitHub Release 的完整流程。构建、测试与冒烟的细节见 [plugin-development-workflow.md](./plugin-development-workflow.md)，本文不重复。

## 发版模型

**手动打 tag 触发**：版本号由 `scripts/bump-version.mjs` 写入 `package.json`，打上 `v<version>` 标签并推送后，GitHub Actions 完成其余一切：

```text
pnpm release patch --tag   # 改版本号 → commit → tag v<version>
git push origin main --follow-tags
        ↓ 触发 .github/workflows/release.yml
verify（复用 ci.yml 全部门禁） → publish（npm publish + GitHub Release）
```

## 一次性配置

- **scope 已存在**：`@dsh-electron` 组织必须已在 npm 上注册且你有发布权限。
- **Trusted publishing（OIDC，当前形态）**：包在 npm 上存在后，已在其 Publish settings → Trusted publisher 中登记本仓库与 `release.yml`。此后发布凭 GitHub Actions 的 OIDC 身份完成（`id-token: write` 权限），仓库不保存任何 npm 凭证，也无需配置 Secret。若在 npm 侧登记了 environment 名，还需给 publish job 声明同名 `environment:`。
- （历史）v0.1.0 是通过带 2FA-bypass 的 Granular Access Token（Secret `NPM_TOKEN`）发布的；npm 正逐步淘汰 2FA-bypass token，首个版本发出后即切换为 trusted publishing 并删除了该 Secret。

## 版本号变更：`scripts/bump-version.mjs`

通过 `pnpm release` 调用（等价于 `node scripts/bump-version.mjs`）：

```sh
pnpm release patch                 # 0.1.0 -> 0.1.1
pnpm release minor                 # 0.1.0 -> 0.2.0
pnpm release major                 # 1.0.0
pnpm release 1.2.3                 # 直接指定版本
pnpm release prerelease --pre rc   # 0.2.0 -> 0.2.0-rc.1（再跑一次 rc.2、rc.3…）
```

行为：

- 默认只改写 `package.json` 的 `version`（保持文件其余部分逐字节不变），打印 `旧版本 -> 新版本`；
- `--tag`：改完后把 `package.json` 单独提交（`chore(release): v<version>`）并打 annotated tag `v<version>`。工作区若有**除 `package.json` 之外**的改动或该 tag 已存在，脚本拒绝执行——发版提交不允许夹带无关变更。

## Release Note：`scripts/release-notes.mjs`

```sh
node scripts/release-notes.mjs v0.1.0   # 本地预览，输出 markdown
```

读取 `git log <上一tag>..<当前tag>`，按 conventional commits 分类（Features / Bug Fixes / Improvements / Documentation / Other Changes），每条附 commit 链接；首个版本无上一 tag 时输出全部历史。发版 tag 必须在本地存在（`--tag` 打出的 tag 天然满足）。workflow 内的 GitHub Release 正文即由该脚本生成。

## Tag 规范与版本一致性

- tag 形如 `v0.1.0`，必须等于 `v` + `package.json` 的 `version`。`release.yml` 在 publish 前强制校验，不一致直接失败——tag 与包内容永不错位。
- 推送方式：`git push origin main --follow-tags`。

## `release.yml` 流程

1. **verify**：`uses: ./.github/workflows/ci.yml`，完整复用 CI 门禁（ubuntu + macOS 矩阵、kernel probe、三个 smoke、docs:check）。任何门禁失败则不发版。
2. **publish**（`needs: verify`，ubuntu-latest）：
   - 校验 tag 与 `package.json` 版本一致；
   - `pnpm install --frozen-lockfile && pnpm build`（`lib/` 不进 git，tarball 必须现构建；client 制品须在 pack 前就绪）；
   - `pnpm pack` 后校验 tarball 内容包含 `cordis.patch.yml`、`lib/index.js`、`lib/client.js`——缺任何一个都会破坏宿主 patch 或 client 启动图（见 [client-bundle-not-in-boot-graph](../troubleshooting/client-bundle-not-in-boot-graph.md)）；
   - `pnpm publish --no-git-checks --provenance` 发布（`--no-git-checks` 是因为 Actions 中处于 detached HEAD）；认证走 npm trusted publishing（OIDC），`package.json` 的 `repository` 字段与 job 的 `id-token: write` 权限是它的前提；
   - 用 `gh release create` 创建 GitHub Release：正文来自 release-notes 脚本，tarball 作为 Release 资产。

`pnpm publish` 的公共访问由 `package.json` 的 `publishConfig.access: "public"` 保证（scoped 包必需）。认证完全依赖 trusted publishing：npm 侧登记的仓库 + workflow 与本次运行必须一致，否则 OIDC 换取发布凭证会被 registry 拒绝（404/403）。

## 首次发版

当前 `package.json` 版本 `0.1.0` 即首个发布版本，无需 bump：

```sh
git tag -a v0.1.0 -m v0.1.0
git push origin v0.1.0
```

之后每次发版：

```sh
pnpm release <patch|minor|major> --tag
git push origin main --follow-tags
```

## 验证

- 发版前本地跑通与 CI 相同的完整门禁：`pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm smoke`（受本机内核方言影响时见开发流程文档的故障排查）。
- 发版完成后到 [npmjs 包页面](https://www.npmjs.com/package/@dsh-electron/dsh-plugin-multi-root-workspace) 与 GitHub Releases 页面确认版本、附件与 Release Note。
