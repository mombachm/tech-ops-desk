#!/usr/bin/env bun
import plugin from "bun-plugin-tailwind";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

const outdir = path.join(process.cwd(), "dist");

if (existsSync(outdir)) {
  await rm(outdir, { recursive: true, force: true });
}

const result = await Bun.build({
  entrypoints: [path.resolve("src/index.html")],
  outdir,
  plugins: [plugin],
  target: "browser",
  minify: true,
  sourcemap: "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  console.error("Build failed");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built ${result.outputs.length} files into ${outdir}`);
