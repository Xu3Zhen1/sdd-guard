// Independent, read-only evidence-chain probe. Production files are imported/executed unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNodeTest, parseMutationReport, missingEvidenceKeys } from '../lib/evidence.mjs';
import { RULES } from '../lib/rules.mjs';

const expectedTmp = resolve(dirname(fileURLToPath(import.meta.url)), 'tmp').replaceAll('\\', '/').toLowerCase();
assert.equal(String(process.env.TMP || '').replaceAll('\\', '/').toLowerCase(), expectedTmp);
assert.equal(String(process.env.TEMP || '').replaceAll('\\', '/').toLowerCase(), expectedTmp);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '_work', 'tmp', 'audit-evidence');
mkdirSync(WORK, { recursive: true });
const records = [];
function run(exe, args, cwd = ROOT) {
  const r = spawnSync(exe, args, { cwd, stdio: 'inherit', shell: false });
  if (r.error) throw r.error;
  return r.status;
}
function script(name, stdout, exitCode = 0) {
  const p = join(WORK, name);
  writeFileSync(p, 'process.stdout.write(' + JSON.stringify(stdout) + '); process.exit(' + exitCode + ');\n');
  return p;
}
function command(p) { return '"' + process.execPath.replaceAll('\\', '/') + '" "' + p.replaceAll('\\', '/') + '"'; }
function config(name, { tests, mutation, drift, requireZeroExit = false }) {
  const p = join(WORK, name);
  writeFileSync(p, JSON.stringify({
    tests: { command: tests },
    mutation: { command: mutation, ...(requireZeroExit ? { requireZeroExit: true } : {}) },
    drift: { command: drift }, keepOutputs: true,
  }, null, 2) + '\n');
  return p;
}
const maker = join(ROOT, 'tools', 'make-evidence.mjs');
const cli = join(ROOT, 'cli.mjs');
const change = join(ROOT, 'test', 'fixtures', 'good', 'changes', 'add-empty-check');

// Probe 1: each TAP counter is independently the first unanchored regex match.
const mixed = ['ℹ tests 999', 'ℹ pass 999', 'ℹ fail 0', 'ℹ tests 2', 'ℹ pass 1', 'ℹ fail 1'].join('\n');
const parsed = parseNodeTest(mixed);
assert.deepEqual({ tests: parsed.total, passed: parsed.passed, failed: parsed.failed }, { tests: 999, passed: 999, failed: 0 });
assert.match(mixed, /ℹ tests 2[\s\S]*ℹ pass 1[\s\S]*ℹ fail 1/);
const e1Direct = RULES.find((r) => r.id === 'ACCEPT-E1').run({ evidence: { tests: parsed }, cfg: {} });
assert.equal(e1Direct.status, 'pass');
records.push({ probe: 'node-test-first-summary-masks-later-failure', parsed: { tests: parsed.total, passed: parsed.passed, failed: parsed.failed }, actualLaterSummary: { tests: 2, passed: 1, failed: 1 }, ACCEPT_E1: e1Direct.status, source: 'lib/evidence.mjs:12-31; lib/rules.mjs:479-495' });

// Probe 2: the parser uses only matched rows as the denominator; run the actual producer
// with a one-row truncated mutation report and exit 1, then consume its output via CLI.
const testProducer = script('probe-tests.mjs', mixed, 0);
const partialMutation = script('probe-partial-mutation.mjs', 'M1 only-reached-mutant ✓\n', 1);
const driftProducer = script('probe-drift.mjs', '检查项 1 · 通过 1 · 漂移 0\n', 0);
const cfg = config('probe-config.json', { tests: command(testProducer), mutation: command(partialMutation), drift: command(driftProducer) });
const evidencePath = join(WORK, 'evidence.json');
const generatedExit = run(process.execPath, [maker, '--config', cfg, '--out', evidencePath, '--cwd', WORK]);
assert.equal(generatedExit, 0, 'default producer accepts parser-valid output despite producer status 1');
const generated = JSON.parse(readFileSync(evidencePath, 'utf8'));
assert.deepEqual({ killed: generated.mutation.killed, total: generated.mutation.total, survived: generated.mutation.survived }, { killed: 1, total: 1, survived: [] });
assert.equal(generated.meta.producers.mutation.exitCode, 1);
const acceptE1 = run(process.execPath, [cli, 'check', '--change', change, '--profile', 'acceptance', '--only', 'ACCEPT-E1', '--evidence', evidencePath]);
const acceptE2 = run(process.execPath, [cli, 'check', '--change', change, '--profile', 'acceptance', '--only', 'ACCEPT-E2', '--evidence', evidencePath]);
assert.equal(acceptE1, 0);
assert.equal(acceptE2, 0);
records.push({ probe: 'truncated-nonzero-mutation-output-yields-1-of-1-and-passes', makeEvidenceExit: generatedExit, mutation: generated.mutation, producerExitInProvenance: generated.meta.producers.mutation.exitCode, acceptE1Exit: acceptE1, acceptE2Exit: acceptE2, source: 'lib/evidence.mjs:47-69; tools/make-evidence.mjs:55-94, 168-179; lib/rules.mjs:499-643' });

// Contrast: the explicit requireZeroExit option rejects the same nonzero producer.
const strictCfg = config('probe-require-zero-config.json', { tests: command(testProducer), mutation: command(partialMutation), drift: command(driftProducer), requireZeroExit: true });
const strictOut = join(WORK, 'evidence-require-zero.json');
const strictExit = run(process.execPath, [maker, '--config', strictCfg, '--out', strictOut, '--cwd', WORK]);
assert.equal(strictExit, 1);
records.push({ probe: 'requireZeroExit-control', makeEvidenceExit: strictExit, evidenceWritten: existsSync(strictOut), source: 'tools/make-evidence.mjs:168-172' });

// Probe 3: failed standalone regeneration does not remove/replace prior evidence;
// the old file is still accepted by the CLI. self-check has an explicit stale-file guard.
const oldBytes = readFileSync(evidencePath);
const badTest = script('probe-no-summary.mjs', 'output with no test summary\n', 0);
const badCfg = config('probe-bad-config.json', { tests: command(badTest), mutation: command(script('probe-good-mutation.mjs', 'M1 mut ✓\n', 0)), drift: command(driftProducer) });
const failedGeneration = run(process.execPath, [maker, '--config', badCfg, '--out', evidencePath, '--cwd', WORK]);
assert.equal(failedGeneration, 1);
assert.deepEqual(readFileSync(evidencePath), oldBytes);
const staleAccept = run(process.execPath, [cli, 'check', '--change', change, '--profile', 'acceptance', '--only', 'ACCEPT-E1', '--evidence', evidencePath]);
assert.equal(staleAccept, 0);
records.push({ probe: 'failed-regeneration-leaves-previous-evidence-usable', failedMakeEvidenceExit: failedGeneration, priorFileUnchanged: true, acceptanceExitUsingStaleEvidence: staleAccept, knownMitigation: 'tools/self-check.mjs removes evidence.json before regeneration', source: 'tools/make-evidence.mjs:182-208; tools/self-check.mjs:130-153' });

// Provenance records are audit metadata, not authenticated producer identity. The CLI's
// acceptance preflight checks only top-level evidence keys; authenticity is a trust boundary.
const noProv = { tests: { passed: 1, failed: 0 }, mutation: { killed: 1, total: 1, survived: [] }, drift: { checks: 1, passed: 1, findings: 0, items: [] } };
assert.deepEqual(missingEvidenceKeys(noProv, ['tests', 'mutation', 'drift']), []);
const noProvPath = join(WORK, 'probe-no-provenance.json');
writeFileSync(noProvPath, JSON.stringify(noProv) + '\n');
const noProvCli = run(process.execPath, [cli, 'check', '--change', change, '--profile', 'acceptance', '--only', 'ACCEPT-E1', '--evidence', noProvPath]);
assert.equal(noProvCli, 0);
records.push({ observation: 'provenance-is-not-authentication', topLevelKeysOnly: true, absentMetaStillHasNoMissingKeys: true, cliAcceptanceExit: noProvCli, source: 'cli.mjs:74-82; lib/evidence.mjs:123-127' });

writeFileSync(join(WORK, 'probe-results.json'), JSON.stringify({ status: 'PASS', records, productionSourceModified: false }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'PASS', records, productionSourceModified: false }, null, 2));
