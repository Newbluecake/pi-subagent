/**
 * Package-root extension entry (source form, for pi).
 *
 * pi loads extensions through jiti (runtime TypeScript), so git installs work
 * with zero build steps — jiti resolves the `.js` suffix below to
 * `src/index.ts`. The compiled `./dist/index.js` entry (see `index.js` and
 * package.json "exports") remains for plain Node consumers; both entries are
 * kept at the package root so pi's resource list shows "pi-subagent/index.*"
 * instead of a nested path.
 */
export * from "./src/index.js";
export { default } from "./src/index.js";
