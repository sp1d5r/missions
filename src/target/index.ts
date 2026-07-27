/**
 * What the harness needs to know about a repo — all of it observed, none of it declared.
 *
 * This module used to export a `Target` interface with a per-repo adapter behind it
 * (`getTarget("generic" | "nadine")`). That could not describe a repo nobody had written an
 * adapter for, which ruled out the two things missions is meant to do: improve itself, and work
 * on whatever you point it at.
 *
 * Everything it held now comes from somewhere that cannot go stale:
 *   dependencies  -> the setup stage installs them and observes the result (setup.ts)
 *   source roots  -> read from the .pth files a venv writes, i.e. the repo stating its own layout
 *   env files     -> discovered as gitignored .env* (the only thing an install cannot recreate)
 *   doctrine      -> AGENTS.md, which workers already load
 *   check command -> the verify step in the repo's setup doc
 */
export { discoverEnvFiles, topLevelRecon } from "./generic.js";
