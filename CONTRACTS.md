# Why missions produce good code and misleading verdicts

Written 2026-07-27 from two real runs. Both shipped competent diffs. Both reported a verdict that
overstated what had been proven, for the same structural reason.

This is not a bug list. Each step in the chain below is individually defensible; the chain is what
produces false confidence.

---

## The evidence

### Run A — `shot_timing` gate fix (target: nadine)

`2/4 assertions, needs-review, $0.98`. The diff was correct: read the nested shot schema, kept flat
support, made skip distinguishable, added a test, and correctly left the gate *failing* because the
underlying content problem was declared out of scope.

The contract was not. Assertion `a1`:

```python
from nadine_shared.reel_engine import gates as G   # imported…
data = json.load(open('…/20_shots.json'))
total = 0.0
for s in shots:                                     # …then reimplements the extraction
    inner = s.get('shot') …
assert abs(total - 15.0) < 1e-6
```

It imports the module under test **and never calls it**. It reimplements the logic and asserts on the
fixture file, so it passes identically whether or not the gate was ever touched. `a2` greps for
whatever test file mentions the fixture path and runs it — the worker's own test grading the worker.

### Run B — per-mission view (target: missions itself)

`6/6 assertions, 0 bugs, CLEAN, $3.87`. Two commits, 965 + 58 lines. The code is good — 18
`appendEvent` call sites across the real lifecycle, `missions view <runId>` exposed and documented.
Verified by hand after the fact.

But the contract was six assertions of which **none executed the feature**:

| assertion | what it actually proves |
|---|---|
| `npm test` | nothing — the repo has no meaningful test suite |
| `node dist/cli.js --help \| grep -Eiq 'view'` | the word "view" appears in help output |
| `test -f src/mission-view.ts && grep -q 'mission-view' src/cli.ts` | a file exists and is imported |
| a4, a5, a6 | a model read the diff and agreed |

Note the `||` in the second one — `view --help >/dev/null || --help | grep -i view`. It was written to
pass either way. A contract that cannot fail is not one.

And the closing move. The worker honestly raised *"End-to-end mission run not verified
interactively"*. The orchestrator ruled it **deferred**, with:

> "The only open issue is that the worker could not run an interactive end-to-end mission in its
> sandbox — **but validators independently confirmed the code behavior**."

The validators did not. They ran a no-op test command, a `test -f`, a `grep`, and three code-reviews.
The mission declared itself CLEAN on a factual claim about its own validation that was untrue.

**Milestone 1 of Run B is the important case**: 6/6 green while the worker itself said the feature did
not work end-to-end (the timeline pane consumed an event log nothing populated). More assertions than
Run A, and *more* false confidence as a result.

---

## The chain

1. The contract is authored in `planMission`, in the **same completion** that produces the plan. One
   model, one breath, at the moment of least knowledge — before any code exists.
2. It is then **frozen**. `CORRECTION_PROMPT` states: *"Do not invent new assertions; the contract is
   fixed."* So it stays existence-only even after the interface exists and behavioural assertions
   become writable.
3. The worker — honestly, in both runs — flags what it could not verify.
4. The orchestrator disposes of that issue with **free-prose justification** that nothing checks.
5. The verdict prints as CLEAN, indistinguishable from a run that proved something.

Two independent forces, worth separating because they need different fixes:

- **Bias.** The party writing the test for the plan is the party that wrote the plan. It will tend to
  write assertions it knows it can satisfy.
- **Timing.** For genuinely new work, a behavioural assertion *cannot* be written up front. There is no
  interface to assert against. `test -f src/mission-view.ts` is the honest ceiling at plan time.

The second is not a failing — it is the nature of building something that does not exist. The failing
is that the contract never gets stronger once that stops being true.

---

## Four changes, in leverage order

### 1. Dispositions must cite evidence, not prose

Highest leverage, smallest change. Today `deferred` accepts free text, so *"validators independently
confirmed"* passes unchallenged.

Require an issue ruling's note to reference **either** a passing assertion id **or** an explicit
out-of-scope line in the RFC. Add an invariant (`invariants.ts`, alongside the existing
`correction.targets-failure`) that rejects a ruling citing validators when no `bash-command` assertion
executed the feature.

This one rule alone would have blocked Run B's verdict.

### 2. Unfreeze the contract, monotonically

Replace *"do not invent new assertions; the contract is fixed"* in `CORRECTION_PROMPT` with:

> You may never weaken, delete or relax an assertion. Once an interface exists that did not exist at
> plan time, you must add behavioural assertions against it.

Milestone 1 proves the thing exists; milestone 2 proves it works. The staging point is the milestone
boundary that already exists. Monotonic, so the contract only ever tightens.

This also explains a warning already being emitted:
`⚠ [correction.targets-failure] m2c1 only targets assertions that already pass`. It fired because
every assertion was green while the feature did not work — there was nothing left to aim at. With a
behavioural contract generated at the boundary, the correction has a real target.

### 3. Make the verdict state its own strength

Pure display, no logic. `CLEAN` on six `test -f` / `grep` assertions should read:

```
CLEAN (existence-only — no assertion executed the feature)
```

Classify each assertion as *existence* or *behavioural* (a `bash-command` that invokes the changed
entry point, versus one that inspects the filesystem or greps source). This is the change that alters
**reviewer** behaviour: a human seeing that label goes and looks, and the whole point of the harness is
that a human reviews a report rather than a diff.

### 4. Reject vacuous check commands

`npm test` on a repo with no tests exits 0 instantly and proves nothing, yet satisfied assertion `a1`
in Run B. The recon-agent work fixes this properly (it would know `npm run build` is the real gate).
A cheap interim guard: a check that exits 0 in under ~200ms with no test files present is not a check
— warn, or refuse to count it.

---

## Deliberately not proposed

- **Making the worker write its own tests and asserting on those.** Run A already did this via `a2`,
  and it is self-grading.
- **Blanket "assertions must execute the changed code path".** Too blunt — it is right for brownfield
  (Run A's `a1` was inexcusable, the function already existed) and impossible for greenfield (Run B had
  no view to invoke). Staging is what reconciles these.
- **A fully adversarial contract agent with no budget.** An agent rewarded for adding assertions can
  make a mission unfinishable. New assertions must be justified by something already in the RFC, which
  is why the RFC has to be comprehensive — it is the source document for what "done" is permitted to
  mean.

---

## What greenfield actually demands

Greenfield does not force weak assertions. It forces the plan to **commit to an interface**. Once the
plan says the CLI will expose `missions view <runId>`, this is writable before a line of code exists,
and it fails today:

```bash
node dist/cli.js view "$RUN_ID" --json | jq -e '.timeline | length > 0'
```

Compare what was actually written — a `grep` for the word "view", with an `||` fallback so it could not
fail. The difference is not greenfield versus brownfield. It is whether the plan committed to a
testable surface.

---

## Open questions

- **Who writes the behavioural contract at the boundary?** An independent agent that sees the goal, the
  RFC and the diff, but never the plan's reasoning, would address bias and timing with one component.
  Untried.
- **How is an assertion classified existence vs behavioural?** Heuristics (`test -f`, `grep`, `ls` →
  existence) are easy but gameable. Having the author declare it, then verifying the declaration, is
  more honest and more work.
- **Should `code-review` assertions count toward the score at all?** Three of Run B's six were
  code-review, and all three passed while the feature did not work. They may belong in the report as
  commentary rather than in the numerator.

---

## Also outstanding in this tree

`src/env.ts`, `src/bootstrap.ts` and `src/mission.ts` carry an uncommitted PATH fix: dependency `bin`
dirs discovered from whatever the bootstrap produced, prepended to PATH. Run A's two assertion failures
were caused by a bare `python` resolving to `/opt/anaconda3/bin/python` — an unrelated interpreter with
none of the repo's dependencies. PYTHONPATH says where modules are; it does not say which interpreter
runs. The change is target-agnostic (it inspects the spec's own dirs, no repo-specific paths).

`verify_stage1.mjs` is currently red: its teardown assumes `node_modules` is a symlink, and it is now a
copy-on-write clone, so cleanup fails with `ENOTEMPTY`. Test bug, not harness bug, but it means the
isolation suite is not currently a valid signal.
