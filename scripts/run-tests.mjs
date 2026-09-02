/**
 * Runs the compiled test files.
 *
 * `node --test "dist/test/*.test.js"` looks tidier, but glob expansion inside
 * the test runner only arrived in Node 22, and leaving the shell to expand it
 * breaks on Windows. Listing the files explicitly works the same everywhere.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../dist/test/", import.meta.url));
const files = readdirSync(directory)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => join(directory, name));

if (files.length === 0) {
  console.error("no compiled tests found in dist/test — run `npm run build` first");
  process.exit(1);
}

const { status } = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(status ?? 1);
