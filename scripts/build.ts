import { fileURLToPath, URL } from "node:url";
import { build, write } from "bun";
import solidPlugin from "@opentui/solid/bun-plugin";

const entry = fileURLToPath(new URL("../src/tui.tsx", import.meta.url));
const outdir = fileURLToPath(new URL("../dist", import.meta.url));

const result = await build({
  entrypoints: [entry],
  outdir,
  naming: "tui.js",
  format: "esm",
  target: "bun",
  packages: "external",
  external: ["solid-js"],
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const item of result.logs) console.error(item);
  process.exit(1);
}

await write(fileURLToPath(new URL("../dist/package.json", import.meta.url)), '{"type":"module"}\n');
