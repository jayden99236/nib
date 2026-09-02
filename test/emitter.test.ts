/**
 * These tests compile nib source to real WebAssembly, hand the bytes to the
 * engine, and call the exported functions. If the emitter produces a byte
 * sequence that wasm will not accept, instantiation throws and the test fails
 * — which is a much stronger guarantee than comparing against a snapshot of
 * whatever the emitter happened to produce that day.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { compile } from "../src/compile.js";
import { compileAndInstantiate } from "../src/run.js";

/** Compile a body into `export fn main()` and call it. */
async function run(body: string, returns = "i32"): Promise<number | undefined> {
  const instance = await compileAndInstantiate(`export fn main() -> ${returns} { ${body} }`);
  return instance.call("main");
}

async function runModule(source: string, ...args: number[]): Promise<number | undefined> {
  const instance = await compileAndInstantiate(source);
  return instance.call("main", ...args);
}

describe("module structure", () => {
  test("starts with the wasm magic number and version", () => {
    const { wasm } = compile("export fn main() -> i32 { return 1; }");
    assert.deepEqual([...wasm.slice(0, 8)], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  });

  test("the engine validates what we emit", () => {
    const { wasm } = compile("export fn main() -> i32 { return 1; }");
    assert.equal(WebAssembly.validate(Uint8Array.from(wasm)), true);
  });

  test("only exported functions are exported", async () => {
    const instance = await compileAndInstantiate(
      "fn hidden() -> i32 { return 1; } export fn shown() -> i32 { return hidden(); }",
    );
    assert.equal(typeof instance.exports["shown"], "function");
    assert.equal(instance.exports["hidden"], undefined);
  });

  test("calling something that is not exported throws a clear error", async () => {
    const instance = await compileAndInstantiate("export fn main() -> i32 { return 1; }");
    assert.throws(() => instance.call("nope"), /not an exported function/);
  });
});

describe("integer arithmetic", () => {
  test("the four operations", async () => {
    assert.equal(await run("return 2 + 3;"), 5);
    assert.equal(await run("return 2 - 3;"), -1);
    assert.equal(await run("return 6 * 7;"), 42);
    assert.equal(await run("return 7 / 2;"), 3); // truncating, signed
    assert.equal(await run("return 7 % 3;"), 1);
  });

  test("division truncates towards zero for negatives", async () => {
    assert.equal(await run("return -7 / 2;"), -3);
    assert.equal(await run("return -7 % 3;"), -1);
  });

  test("precedence survives the round trip through wasm", async () => {
    assert.equal(await run("return 2 + 3 * 4;"), 14);
    assert.equal(await run("return (2 + 3) * 4;"), 20);
    assert.equal(await run("return 100 - 10 - 10;"), 80);
  });

  test("unary minus", async () => {
    assert.equal(await run("return -5;"), -5);
    assert.equal(await run("let x = 5; return -x;"), -5);
    assert.equal(await run("return - -5;"), 5);
  });

  test("large and negative literals encode correctly", async () => {
    assert.equal(await run("return 2147483647;"), 2147483647);
    assert.equal(await run("return -2147483648;"), -2147483648);
    assert.equal(await run("return 1_000_000;"), 1000000);
    assert.equal(await run("return 64;"), 64); // the sleb128 sign-bit edge case
  });
});

describe("floating point", () => {
  test("arithmetic", async () => {
    assert.equal(await run("return 0.1 + 0.2;", "f64"), 0.1 + 0.2);
    assert.equal(await run("return 10.0 / 4.0;", "f64"), 2.5);
    assert.equal(await run("return -1.5;", "f64"), -1.5);
  });

  test("casts convert explicitly in both directions", async () => {
    assert.equal(await run("return 7 as f64 / 2.0;", "f64"), 3.5);
    assert.equal(await run("return 3.9 as i32;"), 3);
    assert.equal(await run("return -3.9 as i32;"), -3);
  });
});

describe("booleans and comparison", () => {
  test("comparisons return 1 and 0", async () => {
    assert.equal(await run("return 1 < 2;", "bool"), 1);
    assert.equal(await run("return 2 < 1;", "bool"), 0);
    assert.equal(await run("return 2 >= 2;", "bool"), 1);
    assert.equal(await run("return 1 == 1;", "bool"), 1);
    assert.equal(await run("return 1 != 1;", "bool"), 0);
  });

  test("float comparisons use the float opcodes", async () => {
    assert.equal(await run("return 1.5 < 2.5;", "bool"), 1);
    assert.equal(await run("return 2.5 <= 2.5;", "bool"), 1);
  });

  test("negation", async () => {
    assert.equal(await run("return !true;", "bool"), 0);
    assert.equal(await run("return !(1 > 2);", "bool"), 1);
  });

  test("&& and || compute the right answer", async () => {
    assert.equal(await run("return true && true;", "bool"), 1);
    assert.equal(await run("return true && false;", "bool"), 0);
    assert.equal(await run("return false || true;", "bool"), 1);
    assert.equal(await run("return false || false;", "bool"), 0);
  });

  test("&& short-circuits, so the right side is never evaluated", async () => {
    // If `boom` ran, dividing by zero would trap and the call would throw.
    const source = `
      fn boom() -> bool { return 1 / 0 == 0; }
      export fn main() -> bool { return false && boom(); }
    `;
    assert.equal(await runModule(source), 0);
  });

  test("|| short-circuits too", async () => {
    const source = `
      fn boom() -> bool { return 1 / 0 == 0; }
      export fn main() -> bool { return true || boom(); }
    `;
    assert.equal(await runModule(source), 1);
  });
});

describe("control flow", () => {
  test("if and else", async () => {
    assert.equal(await run("if 1 < 2 { return 10; } return 20;"), 10);
    assert.equal(await run("if 1 > 2 { return 10; } return 20;"), 20);
    assert.equal(await run("if 1 > 2 { return 10; } else { return 20; }"), 20);
  });

  test("else-if chains", async () => {
    const body = (n: string): string =>
      `let x = ${n}; if x < 0 { return -1; } else if x == 0 { return 0; } else { return 1; }`;
    assert.equal(await run(body("-5")), -1);
    assert.equal(await run(body("0")), 0);
    assert.equal(await run(body("5")), 1);
  });

  test("while loops", async () => {
    assert.equal(await run("let mut i = 0; let mut n = 0; while i < 5 { n = n + i; i = i + 1; } return n;"), 10);
  });

  test("a while loop whose condition starts false never runs", async () => {
    assert.equal(await run("let mut n = 0; while false { n = 1; } return n;"), 0);
  });

  test("nested loops", async () => {
    const body = `
      let mut total = 0;
      let mut i = 0;
      while i < 3 {
        let mut j = 0;
        while j < 3 {
          total = total + 1;
          j = j + 1;
        }
        i = i + 1;
      }
      return total;
    `;
    assert.equal(await run(body), 9);
  });

  test("a loop containing a return exits the function", async () => {
    assert.equal(await run("let mut i = 0; while true { if i == 4 { return i; } i = i + 1; } return -1;"), 4);
  });
});

describe("functions and locals", () => {
  test("parameters arrive in order", async () => {
    assert.equal(await runModule("export fn main(a: i32, b: i32) -> i32 { return a - b; }", 10, 3), 7);
  });

  test("locals are addressed after the parameters", async () => {
    const source = "export fn main(a: i32) -> i32 { let b = a * 2; let c = b + 1; return c; }";
    assert.equal(await runModule(source, 5), 11);
  });

  test("mixed local types get the right slots", async () => {
    const source = `
      export fn main() -> i32 {
        let a = 1;
        let x = 2.5;
        let b = 2;
        return a + b + x as i32;
      }
    `;
    assert.equal(await runModule(source), 5);
  });

  test("recursion", async () => {
    const source = `
      fn fib(n: i32) -> i32 {
        if n < 2 { return n; }
        return fib(n - 1) + fib(n - 2);
      }
      export fn main(n: i32) -> i32 { return fib(n); }
    `;
    assert.equal(await runModule(source, 10), 55);
    assert.equal(await runModule(source, 20), 6765);
  });

  test("mutual recursion", async () => {
    const source = `
      fn is_even(n: i32) -> bool { if n == 0 { return true; } return is_odd(n - 1); }
      fn is_odd(n: i32) -> bool { if n == 0 { return false; } return is_even(n - 1); }
      export fn main(n: i32) -> bool { return is_even(n); }
    `;
    assert.equal(await runModule(source, 10), 1);
    assert.equal(await runModule(source, 7), 0);
  });

  test("a function returning nothing is callable as a statement", async () => {
    const source = `
      fn ignored(a: i32) { let b = a; }
      fn also_ignored() -> i32 { return 7; }
      export fn main() -> i32 { ignored(1); also_ignored(); return 3; }
    `;
    assert.equal(await runModule(source), 3);
  });

  test("shadowed variables keep separate slots", async () => {
    const source = `
      export fn main() -> i32 {
        let x = 1;
        if true { let x = 100; }
        return x;
      }
    `;
    assert.equal(await runModule(source), 1);
  });
});

describe("traps", () => {
  test("integer division by zero traps at run time", async () => {
    const instance = await compileAndInstantiate("export fn main() -> i32 { return 1 / 0; }");
    assert.throws(() => instance.call("main"), WebAssembly.RuntimeError);
  });

  test("float division by zero does not trap", async () => {
    assert.equal(await run("return 1.0 / 0.0;", "f64"), Infinity);
  });
});
