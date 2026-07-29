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

All test files pass cleanly:

```bash
npm test
```

This runs the full suite: `invariants`, `control`, `lifecycle`, `bootstrap`, `ports`, `seats`,
`registry`, `setup`, `workers`, `routines`, `stall`, `verdict`, and `needs`. All thirteen exit
zero on a fresh checkout.

You can also run them individually:

```bash
node test/invariants.mjs   # plan / boundary invariant checks
node test/control.mjs      # TUI frame composition + workspace resolution
node test/lifecycle.mjs    # worktree lifecycle / sweep
node test/bootstrap.mjs    # env-file discovery and copy into worktrees
node test/ports.mjs        # port block derivation and allocation
node test/seats.mjs        # timeline seat inference
node test/registry.mjs     # mission liveness / stall detection
node test/setup.mjs        # setup-record scoping
node test/workers.mjs      # in-process worker steering
node test/routines.mjs     # routine scheduling and deduplication
node test/stall.mjs        # stall detection and finalizeStall helpers
node test/verdict.mjs      # verdict / blocker logic
node test/needs.mjs        # needs-sentence truncation helpers
```

## Other scripts

| command | purpose |
|---|---|
| `npm run dev` | watch-mode recompile |
| `npm run clean` | delete `dist/` |

## web/ — missions console (Next.js)

The `web/` project is a Next.js front-end that imports from `../dist`, so the
root package **must be installed and built first**.

```bash
# 1. Build the root package (produces dist/ that web/ imports)
npm ci
npm run build

# 2. Install web dependencies
cd web
npm ci
```

### Build and verify

```bash
cd web
npm run build      # production build — proves imports from ../dist resolve
npm run typecheck  # TypeScript type-check only (no emit)
```

### Dev server

```bash
cd web
npm run dev   # http://localhost:3200
```

**Port note:** the port is hardcoded as `--port 3200` in `package.json`.
Next.js reads the `PORT` env var only when `--port` is absent, so the scripts
as written do **not** honour `PORT`. To use a different port, edit
`package.json` or pass the flag directly:

```bash
npx next dev --port <PORT>
```

## Notes

- `verify_stage1.mjs` is a separate integration test that exercises the real `nadine` repo at
  `/Users/elijahahmad/nadine`. It is **not** part of the normal test suite; run it only when
  that repo is present and set up.
- The `missions` CLI binary is also installed via `"bin": { "missions": "dist/cli.js" }`;
  after `npm ci` you can run it as `npx missions` or link it globally with
  `npm link`.
- This CLI does not bind any TCP port itself — it communicates over Unix sockets. Port
  management (`src/ports.ts`) is for the *target repos* the org manages, not for the
  missions process itself.
