// npm test: the unit tests (TypeScript, bundled with the esbuild that Vite
// already ships, so no extra dependency) and the IPC contract test, all run by
// node:test.
//
// The TS sources use bundler-style imports (no .ts extensions) and import
// three, so Node can't run them directly; esbuild bundles each test file into
// test/.build/ first, which takes well under a second.

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const unitDir = join(here, "unit");
const outDir = join(here, ".build");

rmSync(outDir, { recursive: true, force: true });
const entries = readdirSync(unitDir).filter((f) => f.endsWith(".test.ts")).map((f) => join(unitDir, f));

await build({
  entryPoints: entries,
  outdir: outDir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  logLevel: "warning",
});

const built = readdirSync(outDir).filter((f) => f.endsWith(".test.mjs")).map((f) => join(outDir, f));
const files = [...built, join(here, "contract.test.mjs")];
const r = spawnSync(process.execPath, ["--enable-source-maps", "--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
