/**
 * Package-root extension entry.
 *
 * pi names package extension items after the entry file's location
 * ("<parentDir>/<fileName>"), so an entry pointing at ./dist/index.js shows
 * up as "dist/index.js" in pi's resource list. This thin re-export puts the
 * entry at the package root, where it displays as "pi-subagent/index.js".
 * The real implementation is compiled to ./dist (see package.json "main").
 */
export * from "./dist/index.js";
export { default } from "./dist/index.js";
