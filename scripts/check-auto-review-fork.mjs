/** Portable differential gate: pristine baseline + explicit patch = fork. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const read = name => readFileSync(new URL(`../src/auto-review/${name}`, import.meta.url), 'utf8')
const baseline = read('upstream.ts'), fork = read('fork.ts')
assert.equal(createHash('sha256').update(baseline).digest('hex'), '1b0ebf6539f2f412c012eadf8049d19f711267040423d7800b3c4f06809413a7', 'upstream baseline drift')
const original = baseline.split('\n'), output = []
let cursor = 0
const lines = read('fork.patch').trimEnd().split('\n')
for (let i=2; i<lines.length;) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++])
  assert.ok(match, 'invalid fork patch hunk')
  const start = Number(match[1])-1
  output.push(...original.slice(cursor,start)); cursor=start
  while (i<lines.length && !lines[i].startsWith('@@')) {
    const line = lines[i++]
    if (line.startsWith(' ') || line.startsWith('-')) assert.equal(original[cursor++],line.slice(1),'patch context drift')
    if (line.startsWith(' ') || line.startsWith('+')) output.push(line.slice(1))
  }
}
output.push(...original.slice(cursor))
assert.equal(output.join('\n'),fork,'fork differs from reviewed patch; review and update fork.patch explicitly')
function section(source,anchor) {
  const start=source.indexOf(anchor)
  assert.ok(start>=0,`missing ${anchor}`)
  const end=source.indexOf('\n/**',start)
  return source.slice(start,end<0?source.length:end).trimEnd()
}
assert.equal(section(fork,'const REVIEW_POLICY ='),section(baseline,'const REVIEW_POLICY ='),'risk policy drift')
for (const name of ['json','parseLoggedArguments','sameJson','isRecord','loggedSchema','isAborted','isHumanInstruction','isProjectInstruction','isCheckpoint','isDirectParentInstruction','directParentInitialPromptSeq','textRole','filteredUserEntries','stepIdentity','sameStep','scopedCallKey','scopePtcStarts','nativeAction','ptcAction','topLevelMemberCount','parseDecision','readDecision','denied','askUser','failed']) {
  assert.equal(section(fork,`function ${name}(`),section(baseline,`function ${name}(`),`${name}: protected upstream behavior drift`)
}
// A native instruction frame is pushed once and shared as a positional history
// placeholder; normalize that deliberate structure back to the upstream shape.
const forkSnapshot = section(fork,'function snapshotAutoReview(')
  .replace(', multiRoot: ReviewContext','')
  .replace('    multiRoot,\n','')
  .replace(`          const entry: HistoricalUserMessage = {
            kind: 'user-message',
            role: 'constraint',
            source: event.data.source,
            content,
          }
          projectInstructions.push(entry)
          // A demoted frame keeps its surface position: this placeholder is
          // rewritten to 'fact' or dropped once partitioning decides.
          history.push(entry)`, `          projectInstructions.push({
            kind: 'user-message',
            role: 'constraint',
            source: event.data.source,
            content,
          })`)
assert.equal(forkSnapshot, section(baseline,'function snapshotAutoReview('),'snapshot identity/filter drift')
assert.equal(fork.slice(fork.indexOf('    yield stopListener')),baseline.slice(baseline.indexOf('    yield stopListener')),'owner registration/disposal drift')
console.log('[auto-review:fork] baseline hash, explicit delta, policy, identity, roles, protocol and owner teardown verified')
