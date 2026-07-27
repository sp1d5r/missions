# Setup

TypeScript/Node project. Requires **Node ≥ 20** (tested on Node 22). Uses npm with a
`package-lock.json` (lockfile version 3).

## Install and build

```bash
npm ci
npm run build
```

`npm run build` compiles with `@typescript/native-preview` (`tsgo`) into `dist/`. It also
`chmod +x dist/cli.js` so the binary is immediately executable.

## Verify

```bash
node dist/cli.js --help
```

Should print the `missions` usage banner. If you see it, the build is good.

## Tests

Three of the four test files pass cleanly on a fresh checkout:

```bash
node test/invariants.mjs   # plan / boundary invariant checks — all pass
node test/control.mjs      # TUI frame composition + workspace resolution — all pass
node test/lifecycle.mjs    # worktree lifecycle / sweep — all pass
```

The fourth file (`test/bootstrap.mjs`) is **currently broken** — it tests a `spec`-based API
(`linkDirs`, `cloneDirs`, `linkedDirs`, `clonedDirs`) that no longer matches the
`bootstrapWorktree` implementation. This is a known in-progress state described in
`HANDOVER.md` and `CONTRACTS.md`; it is a test bug, not a build bug. As a result,
`npm test` (which runs all four) exits non-zero. Use the three individual commands above as
the smoke-check instead.

## Other scripts

| command | purpose |
|---|---|
| `npm run dev` | watch-mode recompile |
| `npm run clean` | delete `dist/` |

## Notes

- `verify_stage1.mjs` is a separate integration test that exercises the real `nadine` repo at
  `/Users/elijahahmad/nadine`. It is **not** part of the normal test suite; run it only when
  that repo is present and set up.
- The `missions` CLI binary is also installed via `"bin": { "missions": "dist/cli.js" }`;
  after `npm ci` you can run it as `npx missions` or link it globally with
  `npm link`.
