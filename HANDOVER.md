# Handover — mission environment isolation (stage 1)

Status: **shipped and verified**. Written 2026-07-27.

Scope: making `missions` safe to run long-running agents in parallel against a real repo.
Stage 2 (agent-friendliness — `AGENTS.md`) is **also done**; see the end of this doc.

---

## The problem this solved

`git worktree add` carries tracked files and nothing else. A worker dropped into that tree had
no env files, no venvs and no `node_modules` — and instead of failing loudly, it silently fell
back to the main checkout in three separate ways.

**1. Env came from the parent by accident.** Nadine's `Config` calls
`find_dotenv(usecwd=True)` then `load_dotenv(override=True)`. `find_dotenv` walks *up*, and
worktrees live at `<repo>/.missions/worktrees/<id>`, so every mission picked up the main
checkout's `.env`. That "worked", which is what made it dangerous: every parallel agent shared
one set of live production credentials, and it would break the day worktrees moved outside the
repo. `override=True` also means **you cannot override config by injecting an env var** — the
file wins. Overrides have to be written into the worktree's `.env`.

**2. Python imported the wrong tree.** Service venvs carry a `.pth` with an absolute path into
the main checkout (`backend/.venv/…/nadine_backend.pth` → `<repo>/backend/src`) plus built
copies of `nadine_shared` and `naomi_agent` in `site-packages`. Measured, from a worktree:

```
without PYTHONPATH:  app -> /Users/elijahahmad/nadine/backend/src/app/        # MAIN checkout
                     nadine_shared -> …/backend/.venv/…/site-packages/…      # stale copy
with PYTHONPATH:     app -> …/.missions/worktrees/m-…/backend/src/app/       # correct
```

PYTHONPATH is resolved *before* `.pth` entries, so a worktree-rooted PYTHONPATH is the fix. A
worker editing `shared/` and running a test was otherwise testing code it had never touched.

**3. Assertions validated the main checkout.** The orchestrator was handed `config.targetCwd`,
so it wrote assertions like `cd /Users/elijahahmad/nadine && gh run list …`, and `runCheck` ran
them with `bash -lc`. From `.missions/runs/run-2026-07-24T23-44-54-731Z/mission.log`:

```
validator: assert a3: cd /Users/elijahahmad/nadine && gh run list --limit 10 …
```

That is why those runs scored 2/4 and 3/4, and why the second mission existed only to
re-verify the first. Half the contract was measuring a different tree.

**4. Node env was simply absent.** `naomi-web/.env.local`, `website/.env.local` are read by
Next and Vite *from their own project dir*, so the upward-walk accident did not rescue them.
Any `naomi-web` mission ran blind.

---

## What is in place now

| File | Role |
|---|---|
| `src/env.ts` | `parseEnvFile` / `serializeEnvFile` / `resolveMissionEnv` — worktree-rooted `PYTHONPATH`, `MISSIONS_*` markers, overrides |
| `src/bootstrap.ts` | `bootstrapWorktree` copies env files, symlinks deps; `applyEnvOverrides` rewrites the worktree `.env` |
| `src/db-branch.ts` | `planTouchesSchema` + `provisionDbBranch` (Neon), gated on credentials |
| `src/target/types.ts` | `Target` gained `bootstrapSpec()` and `envDoctrine` |
| `src/target/nadine.ts` | the real env-file / link-dir / source-root lists, and the environment doctrine text |
| `src/worker.ts` | env per command via pi's `createCodingTools(cwd, { bash: { spawnHook } })`; worktree + doctrine in the prompt |
| `src/orchestrator.ts` | `planMission(config, recon, PlanContext{workCwd, envDoctrine})`; assertions told to stay relative |
| `src/validators/checks.ts` | `runCheck({cwd, command, env, foreignRoot})`; refuses foreign-root commands with `REFUSED_EXIT_CODE` (126); `bash -c`, not `-lc` |
| `src/git.ts` | `commitAll(cwd, msg, excludePaths)` |

**Env files are copied, not symlinked** — deliberately. A shared file would beat mission
overrides under `override=True`, and a copy gives the mission a frozen, inspectable snapshot.

**Dependencies are symlinked** — `.venv` per service, `node_modules` per project, plus the
gitignored `pi-mono` sibling checkout. They are therefore **shared and read-only**: installing
into one mutates every tree. The worker prompt says so explicitly. This is also what removed
the ~10 minutes and ~$2 the first mission spent running `pdm install` itself.

### One trap worth knowing

nadine's `.gitignore` uses directory-only patterns (`node_modules/`, `pi-mono/`) and **git does
not match those against a symlink**. So bootstrapped links show up as untracked, and the old
`git add -A` would have committed symlinks pointing at the main checkout. `commitAll` now stages,
then `git reset -q --` the harness's own paths, and asks whether anything is *staged* rather than
whether the tree is dirty (the excluded paths stay untracked on purpose, so a dirty tree is
normal here).

`:(exclude)` pathspecs do **not** work for this — `git add` errors outright when a pathspec
matches an already-ignored path.

---

## Environment doctrine (Elijah's, 2026-07-26)

Encoded in `nadineTarget.envDoctrine` and handed verbatim to workers and the planner:

- **Local** is Elijah's machine only. **Production** is the only other environment.
- There are no customers yet, so **almost everything legitimately touches production**. The
  credentials in a worktree's `.env` are live: prod Neon, real R2, real Stripe, metered media
  providers that bill per call.
- Reads and ordinary row writes are accepted. Spending money is not — no generating images,
  video or voice to "check" something unless the feature is about that.
- **Schema changes are the only thing isolated**, because DDL is the one action a parallel
  worker can take that breaks every other tree at once.

So there is no blanket sandbox, by design. `planTouchesSchema()` scans the plan for
alembic/migration/DDL signals; only then do we branch.

---

## Verify it

```bash
cd ~/missions && npm run build && node verify_stage1.mjs
```

25 checks against a real throwaway nadine worktree, cleaned up after itself. It asserts the
positive cases *and* that the bug is still real without the fix (`without PYTHONPATH it really
does leak to the main checkout`) — so it fails if the fix ever becomes a no-op. Last run:
**25/25**, on the tree at `5393211`.

---

## Outstanding — decisions, not work

**1. `hydrate_env.py --write` has not been run.** `nadine/scripts/hydrate_env.py` (committed in
nadine as `fcb9f5ae`) rebuilds `.env` from SSM `/nadine/*` — the same place ECS reads. Reports
by default, never prints a value, preserves keys that exist only locally. First `--check`:

- 27 keys in SSM missing locally (incl. `CLERK_SECRET_KEY`, `AGENT_RUNNER_URL`, `STRIPE_*`)
- 4 changed, incl. all three `NAOMI_STRIPE_*`
- `NAOMI_STRIPE_WEBHOOK_SECRET` is **empty locally** while SSM has a real value
- 9 local-only keys: `DEEPGRAM_API_KEY`, `NAOMI_WORKSPACE_R2_BUCKET`, `BACKEND_API_URL`,
  `APIFY_INSTAGRAM_ACTOR_ID`, + 5 dead `NAOMI_JUICEFS_*` — production cannot see any of them
- two typo'd SSM params shadowing correct ones: `/nadine/envrionment`, `/nadine/segmine_api_key`

Not run because local values may be deliberate and it rewrites live credentials. It backs up
first. Elijah's call.

**2. Neon branching is LIVE and verified** (2026-07-27). `NEON_API_KEY` and `NEON_PROJECT_ID` are
in the root `.env` and in SSM as `/nadine/neon_api_key` and `/nadine/neon_project_id` (both
SecureString). Verified end-to-end against the real `nadeen` project: a schema-touching plan
branches in ~1s, a non-schema plan correctly does not, teardown removes it in ~0.2s and leaves no
orphan.

No ECS service reads them yet — `ssm_loader.py` only fetches what a task definition lists in
`ENVIRONMENT_VARS`, and nothing server-side references `NEON_` at all. Deliberate: the key can
create and delete database branches, so when something does need it, add it to the **agent-runner**
list (`infra/__main__.py:269`) rather than `BACKEND_ENV_VARS` — smaller blast radius than handing
branch-delete powers to the public API service.

Costs, measured rather than assumed (Launch plan: storage $0.35/GB-month, compute $0.106/CU-hour):

| scenario | cost |
|---|---|
| branch torn down after 30 min @ 0.25 CU | **$0.013** |
| storage delta (branch starts at 0 bytes vs a 15.3GB parent — copy-on-write) | ~$0.001/hour for a 2GB delta |
| orphan with autosuspend working | ~$0.70/month |
| orphan @ 0.25 CU never suspending | ~$19/month |
| orphan @ 2 CU never suspending | ~$155/month |

Storage is a non-issue; compute orphans are the whole risk. So `db-branch.ts` pins the endpoint's
own limits instead of inheriting the project defaults (which handed out 0.25–**2** CU with an
implicit idle timeout), and sweeps `missions/*` branches older than six hours on the way in —
because `finally` cannot run if the daemon is killed or the machine sleeps, which is exactly the
case that leaves compute running. Worst case is now ~$0.64 rather than unbounded.

Note the Launch-plan floor: `suspend_timeout_seconds` below 300 is rejected with
`412 suspend interval is too short for your plan`.

**3. `runBehavioral` does not receive `missionEnv`.** `nadineTarget.runBehavioral` derives
PYTHONPATH from its own `cwd`, so it reads the right tree, and DB overrides reach it through the
worktree `.env` on disk. Correct today, but it is the one path that resolves env independently —
worth unifying if a target ever needs an override that is *not* in a file.

---

## Hazard: concurrent sessions share one working tree

Two Claude sessions plus the `missions` daemon operate on the same checkout, with no
per-session branches. Observed repeatedly on 2026-07-26/27: another session's
`git add -A` swept this work into unrelated commits —

- `4b18e52 feat(tui): …` → `src/env.ts`, `src/db-branch.ts`
- `779e39b feat(report): …` → `src/bootstrap.ts`, `verify_stage1.mjs`

Nothing was lost, but authorship and atomicity were. Before editing, check
`git log --oneline -3` and file mtimes; a commit newer than your last read means someone is live
in the tree, so re-read before editing. Stage your own paths, never `-A`. Edit-tool collisions
fail loudly; commits fail silently.

---

## Stage 2 — done (2026-07-27)

Workers were opening on a 2,846-file monorepo knowing only their one feature. `runWorker` loaded no
context file at all, and the root `AGENTS.md` that existed was a Cursor Cloud artifact — `/workspace`
paths, pointing at the Cursor-only `generate_env.sh`, naming Firebase as *the* auth system, and
describing five services while saying nothing about `naomi/`, `naomi-mcp/`, `agent_runner/`,
`naomi-web/` or `pi-extension-e2b-hands/`. An agent that trusted it would build against the
meditation app.

**Both halves are now in place:**

1. nadine's root `AGENTS.md` rewritten (nadine `abc0e1b4`, extended `5816846f`) — 207 lines / 11.9KB.
   Naomi-first, the virtual-hands runtime with the in-box path marked dead, the two-environment
   doctrine, the `PYTHONPATH`-beats-`.pth` import rule, provider routing with BytePlus excluded, the
   Clerk/Firebase split *by product*, the standing rules, and a per-area trap list. Every path and
   command in it was verified to exist before committing.
2. `worker.ts` loads it via pi's `loadProjectContextFiles` (missions `957d9b5`), so the file governing
   a worker is the same one governing an interactive pi session in that directory.

**The filter in `repoContext` is load-bearing, not tidiness.** Mission worktrees live at
`<repo>/.missions/worktrees/<id>`, so ancestor discovery also finds the **parent checkout's**
`AGENTS.md` — a different tree, at a different commit, possibly with uncommitted edits. Measured from a
real worktree: discovery returned 2 files, and before filtering a worker would have received both the
new rules and the stale Cursor-era ones and been left to choose. After filtering to this-tree-plus-global:
1 file, 11,840 chars.

**Per-directory `AGENTS.md` was deliberately NOT done.** pi walks the global agent dir plus **cwd's
ancestors only** — no nested or on-demand loading — so a file in `naomi/` is invisible from the repo
root, which is where every worker sits. Six such files would be six files nothing reads. The knowledge
went into the root file's per-area section instead. Revisit only if the root file gets too crowded, and
if so the fix is ~20 lines in `repoContext` to also collect `AGENTS.md` from the directories a feature
touches.

Still unused: `.agents/skills/` and `.claude/skills/` (both populated), and `.cursor/rules/*.mdc`
(9 files of real frontend convention that only Cursor reads — the root file now points at them).
