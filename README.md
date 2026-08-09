# pi-missions

Your engineering org: generic long-running coding agents that plan themselves, work any repo, and report at standups with glanceable artifacts.

## Install and build

```bash
npm ci
npm run build
```

`npm run build` compiles with `@typescript/native-preview` (`tsgo`) into `dist/`.

> **Note:** Installing this package does **not** automatically download the Chromium browser.
> The `postinstall` hook has been intentionally removed to avoid forcing a large binary download
> on every consumer of the package. Run the setup script manually if you need screenshot support.

## Screenshot support (optional)

The screenshot tool requires Playwright's Chromium browser. Install it once after `npm ci`:

```bash
npm run setup:playwright
```

This downloads the Chromium binary that the `screenshot` tool uses for headless captures.
You only need to run this once per machine (or after upgrading Playwright).

If you skip this step, the rest of the package works normally — the screenshot tool will
throw at runtime if Chromium is not installed.

## Verify

```bash
node dist/cli.js --help
```

Should print the `missions` usage banner.

## Tests

```bash
npm test
```

To run the screenshot-specific tests (requires Chromium to be installed):

```bash
node test/screenshot-a9-image-event.mjs
node test/screenshot-a10-store-event.mjs
node test/screenshot-a12-png-magic.mjs
node test/screenshot-a14-distinct-content.mjs
node test/screenshot-a15-stdin-unref.mjs
node test/screenshot-a17-listener-count.mjs
node test/screenshot-a18-dedupe.mjs
node test/screenshot-a19-no-signal-handlers.mjs
node test/screenshot-a20-no-getActiveHandles.mjs
node test/screenshot-a21-browser-reuse.mjs
node test/screenshot-a22-one-image-event.mjs
node test/screenshot-a25-refcount.mjs
node test/screenshot-browser-reuse.mjs
node test/screenshot-concurrent-workers.mjs
```

End-to-end screenshot test:

```bash
npm run e2e:screenshot
```

## Other scripts

| command | purpose |
|---|---|
| `npm run dev` | watch-mode recompile |
| `npm run clean` | delete `dist/` |
| `npm run setup:playwright` | download Chromium for the screenshot tool |
| `npm run e2e:screenshot` | end-to-end screenshot test |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design documentation.

## Setup notes

See [SETUP.md](./SETUP.md) for environment-specific setup instructions.
