import { cp, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "dist");
const watch = process.argv.includes("--watch");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(path.join(here, "public"), outdir, { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: {
    background: path.join(here, "src/background/index.ts"),
    content: path.join(here, "src/content/index.ts"),
    popup: path.join(here, "src/ui/popup.ts"),
  },
  outdir,
  bundle: true,
  format: "esm",
  target: "chrome116",
  platform: "browser",
  sourcemap: watch ? "inline" : true,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching…");
} else {
  await esbuild.build(options);
  console.log(`built -> ${path.relative(process.cwd(), outdir)}`);
}
