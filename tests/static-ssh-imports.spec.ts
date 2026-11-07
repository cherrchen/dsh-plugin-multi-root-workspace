import { expect, it } from 'vitest'
import { staticSshImports } from '../scripts/lib/static-ssh-imports.mjs'

it('rejects static SSH imports and re-exports including public subpaths', () => {
  expect(staticSshImports(`
    import Connection from '@deepseek-ai/dsh-ssh';
    import '@deepseek-ai/dsh-fs-ssh';
    export * from '@deepseek-ai/dsh-sandbox-ssh';
    export { default as Runtime } from '@deepseek-ai/dsh-subprocess-ssh/public';
  `)).toEqual([
    '@deepseek-ai/dsh-ssh', '@deepseek-ai/dsh-fs-ssh',
    '@deepseek-ai/dsh-sandbox-ssh', '@deepseek-ai/dsh-subprocess-ssh/public',
  ])
})

it('permits deferred loading without treating strings or comments as imports', () => {
  expect(staticSshImports(`
    // import '@deepseek-ai/dsh-ssh';
    const example = "import Connection from '@deepseek-ai/dsh-fs-ssh'";
    import Local from '@deepseek-ai/dsh-fs-local';
    const load = () => import('@deepseek-ai/dsh-ssh');
    const resolve = () => require.resolve('@deepseek-ai/dsh-sandbox-ssh');
  `)).toEqual([])
})
