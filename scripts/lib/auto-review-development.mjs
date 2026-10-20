/** Development-only packages for the exact-version fork and its upstream tests.
 * Ordinary matrix lanes omit these: several did not exist in older releases.
 * This is dependency ownership, not another runtime support allowlist.
 */
export const AUTO_REVIEW_DEVELOPMENT_PACKAGES = [
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-agent-loop-testkit",
  "@deepseek-ai/dsh-bash-sandbox",
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-fs-observation-policy",
  "@deepseek-ai/dsh-llm-deepseek",
  "@deepseek-ai/dsh-llm-deepseek-api-key",
  "@deepseek-ai/dsh-permission-presets",
  "@deepseek-ai/dsh-ptc-runtime-node",
  "@deepseek-ai/dsh-shell",
  "@deepseek-ai/dsh-shell-env",
  "@deepseek-ai/dsh-subagent",
  "@deepseek-ai/dsh-tool-bash",
  "@deepseek-ai/dsh-tool-fs",
  "@deepseek-ai/dsh-tool-subagent",
  "@deepseek-ai/dsh-user-approval",
  "@deepseek-ai/dsh-working-directory",
  "@deepseek-ai/dsh-util-values"
]

export function autoReviewRelease(source) {
  const release = /AUTO_REVIEW_RELEASE = '([^']+)'/u.exec(source)?.[1]
  if (release === undefined) throw new Error('Auto Review exact release contract is unreadable')
  return release
}
