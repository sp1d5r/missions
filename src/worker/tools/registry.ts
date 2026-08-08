/**
 * Worker tool registry — thin re-export so external callers can import
 * getWorkerTool from a stable path that does not drag in the full worker module.
 *
 * Usage:
 *   import { getWorkerTool } from './dist/worker/tools/registry.js';
 *   const tool = getWorkerTool('screenshot');
 *   await tool?.run({ url: 'data:text/html,<h1>hi</h1>' });
 */

export { getWorkerTool } from "../../worker.js";
