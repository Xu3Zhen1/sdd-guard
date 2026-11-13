# Evidence chain audit

## Scope and execution

Read-only review: lib/evidence.mjs, tools/make-evidence.mjs, tools/make-diff.mjs, cli.mjs and the acceptance consumers in lib/rules.mjs; contract references in docs/ICD.md and docs/DESIGN-RATIONALE.md. No production source or existing test was modified.

Independent probe: _work/audit-evidence-probe.mjs. Generated fixture/output files and raw output are under _work/tmp/audit-evidence/ (ignored). Probe status: PASS, process exit 0. Results: _work/tmp/audit-evidence/probe-results.json; full run log: _work/tmp/audit-evidence/probe-run.log.

PowerShell launcher could not start in this session (process spawn returned ENOENT before executing a command). The probe was run with the bundled Node executable; child processes used stdio inherit or file redirection, never piped capture. TMP and TEMP were each set to sdd-guard/_work/tmp in the probe process and inherited by its children. Thus the required temp location was observed, but the pwsh invocation itself was not available.

## Four false-green observations

### 1. Repeated TAP summaries: the first matching counters mask later failures (confirmed)

Source: lib/evidence.mjs:12-31 independently takes the first unanchored match for tests, pass, and fail. It does not require a unique summary group or associate the counters with the same group. Its only arithmetic check is pass + fail <= tests. ACCEPT-E1 passes when parsed passed > 0 and failed === 0 (lib/rules.mjs:479-495).

Probe input contained an initial 999 tests / 999 pass / 0 fail summary and a later 2 tests / 1 pass / 1 fail summary. The parser returned 999/999/0; acceptance CLI for ACCEPT-E1 exited 0. This proves the selection flaw with a synthetic duplicate-summary output; it does not assert that ordinary Node reporters always emit duplicate summaries.

The drift parser uses the same first-match style for its summary (lib/evidence.mjs:73-86); no separate drift behavior probe was run.

### 2. A partial nonzero mutation report becomes a 1/1 acceptance pass (confirmed)

Source: lib/evidence.mjs:47-69 counts only lines matching the mutation-row regex and defines total as that count. No expected mutation inventory or completion marker is required. tools/make-evidence.mjs:156-175 intentionally accepts parser-valid output from a nonzero producer by default, preserving the exit code as a warning/provenance field; requireZeroExit:true opts into rejection. ACCEPT-E2 checks the inferred ratio and internal consistency (lib/rules.mjs:499-643), not report completeness.

Probe producer emitted only one row, M1 ... ✓, then exited 1. Default make-evidence exited 0 and wrote killed=1,total=1,survived=[] with producer exitCode=1 in metadata. CLI ACCEPT-E1 and ACCEPT-E2 both exited 0; E2 reported 1/1 = 1.00 >= 0.8. With the same producer and requireZeroExit:true, make-evidence exited 1 and did not write an evidence file.

The policy to retain parseable nonzero results is intentional (tools/make-evidence.mjs:156-166); the false-green is that a truncated population cannot be distinguished from a complete one-row population. docs/ICD.md:321-325 still states that every nonzero command is rejected, which contradicts current code and should be reconciled.

### 3. Failed standalone regeneration leaves old evidence usable (confirmed)

Source: tools/make-evidence.mjs:182-208 exits before final output write on any collected failure but does not invalidate an existing --out file before starting. tools/self-check.mjs:130-153 explicitly deletes its old evidence first, documenting/mitigating this stale-file hazard on the self-check path.

Probe first created valid evidence, then ran generation to the same output path with a test command that emitted no parseable summary. Second make-evidence exit was 1; prior output remained byte-identical; CLI then accepted that stale file for ACCEPT-E1 and exited 0. The issue is demonstrated for direct/standalone generation; self-check’s pre-delete is a known mitigation.

### 4. Evidence without provenance metadata passes CLI preflight (confirmed behavior; trust boundary, not authenticated-source defect)

Source: cli.mjs:74-82 requires the three top-level keys only. lib/evidence.mjs:123-127 implements missingEvidenceKeys as a null/undefined check on those keys. Probe supplied tests, mutation, and drift fields with no meta object or producers and CLI ACCEPT-E1 exited 0.

This confirms provenance is not required by the acceptance CLI. It does not establish that a producer was malicious or that the result was fabricated. The evidence docs call for an external/project-owned producer, but the inspected contract does not define a producer-authentication or source-revision binding protocol. Therefore this is a trust-contract gap/limit, not by itself a demonstrated exploit absent an explicit requirement to reject handwritten evidence. Provenance fields are audit metadata, not authenticated identity; a separate process is not inherently independent or secure.

Successful make-evidence output records command, exitCode, cwd, output sha256 and bytes (tools/make-evidence.mjs:82-93). digest truncates the output hash to 16 hex characters (lib/evidence.mjs:118-120). These fields do not prove the command ran, authenticate who generated the JSON, or bind evidence to a source revision/tree. Requiring metadata presence alone would not solve that.

## make-diff review and unexecuted branches

Static source review: tools/make-diff.mjs:75-101 defaults to git diff --numstat HEAD; its parser only includes returned numstat rows (tools/make-diff.mjs:111-128), with no independent untracked-file enumeration. By Git semantics, new untracked files do not appear in that diff until staged; this can omit a declared new file. DISCIPLINE-C3 treats an empty diff as skip, not pass (lib/rules.mjs:829-833), but this audit did not behaviorally execute make-diff for untracked files.

Not behaviorally tested: make-diff untracked-file omission, rename and unusual path parsing, staged/base/range modes, binary diff budget semantics, interruption/timeout handling, and drift parser ambiguity. The source-level untracked observation is not counted among the four executed false-green probes. Lead’s separately reproduced numeric-domain/schema cases were not repeated.

## Results and disposition

- Five probe assertions executed successfully: TAP first-summary behavior; truncated nonzero mutation output accepted by default; requireZeroExit control rejects it; failed generation preserves old output which CLI reuses; missing provenance is accepted by CLI preflight.
- Probe process exit: 0. PASS means the assertions reproduced the observed behavior, not that the paths are safe.
- Three confirmed false-green paths: summary first-match ambiguity, mutation report completeness inferred from matched rows, stale-output reuse after failed standalone generation.
- One additional confirmed behavior is reported as a trust-contract boundary: provenance is optional metadata, not authentication/source binding.
- No production source or existing tests were modified. make-diff conclusions remain static-only and are explicitly unverified at runtime.
