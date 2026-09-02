import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function nib(...args: string[]): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

let workspace = "";
const file = (name: string): string => join(workspace, name);

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "nib-cli-"));
  await writeFile(
    file("good.nib"),
    "fn double(n: i32) -> i32 { return n * 2; }\nexport fn main(n: i32) -> i32 { return double(n) + 1; }\n",
  );
  await writeFile(file("type-error.nib"), "export fn main() -> i32 {\n  return 1 + 1.5;\n}\n");
  await writeFile(file("syntax-error.nib"), "export fn main() -> i32 {\n  return 1\n}\n");
  await writeFile(file("trap.nib"), "export fn main() -> i32 { return 1 / 0; }\n");
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("nib run", () => {
  test("prints the result of calling main", async () => {
    const { code, stdout } = await nib("run", file("good.nib"), "20");
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "41");
  });

  test("passes several arguments through", async () => {
    await writeFile(file("sum.nib"), "export fn main(a: i32, b: i32) -> i32 { return a + b; }\n");
    const { stdout } = await nib("run", file("sum.nib"), "3", "4");
    assert.equal(stdout.trim(), "7");
  });

  test("can call an export other than main", async () => {
    await writeFile(file("two.nib"), "export fn other() -> i32 { return 9; }\n");
    const { stdout } = await nib("run", file("two.nib"), "--export", "other");
    assert.equal(stdout.trim(), "9");
  });

  test("reports a run-time trap without a stack trace", async () => {
    const { code, stderr } = await nib("run", file("trap.nib"));
    assert.equal(code, 1);
    assert.match(stderr, /trapped at run time/);
    assert.doesNotMatch(stderr, /at Object|node:internal/);
  });
});

describe("nib check and ast", () => {
  test("check succeeds quietly on a good file", async () => {
    const { code, stdout } = await nib("check", file("good.nib"));
    assert.equal(code, 0);
    assert.match(stdout, /type-checks/);
  });

  test("ast prints the parsed tree", async () => {
    const { stdout } = await nib("ast", file("good.nib"));
    assert.match(stdout, /\(fn double \(n:i32\) -> i32/);
    assert.match(stdout, /\(export fn main/);
  });
});

describe("nib build", () => {
  test("writes a wasm file the engine accepts", async () => {
    const output = file("out.wasm");
    const { code, stdout } = await nib("build", file("good.nib"), "-o", output);

    assert.equal(code, 0);
    assert.match(stdout, /wrote .*out\.wasm \(\d+ bytes\)/);

    const bytes = await readFile(output);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
    assert.equal(WebAssembly.validate(bytes), true);
  });
});

describe("error reporting", () => {
  test("a type error is rendered with the line and a caret", async () => {
    const { code, stderr } = await nib("run", file("type-error.nib"));
    assert.equal(code, 1);
    assert.match(stderr, /type-error\.nib:2:10: check error/);
    assert.match(stderr, /2 \|\s+return 1 \+ 1\.5;/);
    // The caret spans the whole offending expression, not just its first byte.
    assert.match(stderr, /\^{7}/);
    assert.match(stderr, /help: nib has no implicit conversions/);
  });

  test("a syntax error names what was expected", async () => {
    const { code, stderr } = await nib("run", file("syntax-error.nib"));
    assert.equal(code, 1);
    assert.match(stderr, /parse error: expected ';'/);
  });

  test("a missing file is a usage error, not a crash", async () => {
    const { code, stderr } = await nib("run", file("nope.nib"));
    assert.equal(code, 2);
    assert.match(stderr, /cannot read/);
  });

  test("an unknown command shows the usage text", async () => {
    const { code, stderr } = await nib("frobnicate", file("good.nib"));
    assert.equal(code, 2);
    assert.match(stderr, /unknown command 'frobnicate'/);
    assert.match(stderr, /usage:/);
  });

  test("--help exits successfully", async () => {
    const { code, stdout } = await nib("--help");
    assert.equal(code, 0);
    assert.match(stdout, /compiles to WebAssembly/);
  });
});

describe("the bundled examples", () => {
  const examples = fileURLToPath(new URL("../../examples/", import.meta.url));

  test("fib.nib sums the first twenty Fibonacci numbers", async () => {
    const { stdout } = await nib("run", join(examples, "fib.nib"));
    assert.equal(stdout.trim(), "10945");
  });

  test("collatz.nib finds the longest chain under 10000", async () => {
    const { stdout } = await nib("run", join(examples, "collatz.nib"));
    assert.equal(stdout.trim(), "6171");
  });

  test("sqrt.nib converges on the square root of two", async () => {
    const { stdout } = await nib("run", join(examples, "sqrt.nib"));
    assert.ok(Math.abs(Number(stdout.trim()) - Math.SQRT2) < 1e-6);
  });
});
