// Builds the React runtime artifact previews load (src/runtime) into
// dist/runtime/react-runtime.js: one self-contained script, since the preview
// frame has no network and no access to the app's own bundle. Runs after
// `vite build` (which empties dist/) and before `npm run dev`.

import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src", "runtime", "artifact-runtime.ts")],
  outfile: join(root, "dist", "runtime", "react-runtime.js"),
  bundle: true,
  format: "iife",
  globalName: "ArcRuntime",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
