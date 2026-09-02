import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { check } from "../src/checker.js";
import { NibError } from "../src/diagnostics.js";
import { parse } from "../src/parser.js";

const accepts = (source: string): void => {
  check(parse(source));
};

const rejects = (source: string, pattern: RegExp): void => {
  assert.throws(() => check(parse(source)), pattern);
};

/** Wrap an expression in a function returning the given type. */
const inFn = (body: string, returns = "i32"): string => `fn f() -> ${returns} { ${body} }`;

describe("literals and inference", () => {
  test("integer literals are i32 and float literals are f64", () => {
    accepts(inFn("return 1;"));
    accepts(inFn("return 1.5;", "f64"));
  });

  test("let infers the type of its initialiser", () => {
    accepts(inFn("let x = 1; return x;"));
    accepts(inFn("let x = 1.5; return x;", "f64"));
    accepts(inFn("let b = true; return b;", "bool"));
  });

  test("an annotation must agree with the initialiser", () => {
    accepts(inFn("let x: i32 = 1; return x;"));
    rejects(inFn("let x: f64 = 1; return x;", "f64"), /declared f64 but the initialiser is i32/);
  });

  test("the int-to-float mistake gets a useful hint", () => {
    try {
      check(parse(inFn("let x: f64 = 1; return x;", "f64")));
      assert.fail("expected a type error");
    } catch (error) {
      assert.ok(error instanceof NibError);
      assert.match(error.diagnostic.help ?? "", /1\.0.*as f64/);
    }
  });

  test("rejects an unknown type name", () => {
    rejects("fn f(a: u8) -> i32 { return 1; }", /unknown type 'u8'/);
  });
});

describe("no implicit conversions", () => {
  test("mixing i32 and f64 in arithmetic is an error", () => {
    rejects(inFn("return 1 + 1.5;"), /both sides to be the same type/);
  });

  test("an explicit cast fixes it", () => {
    accepts(inFn("return 1 as f64 + 1.5;", "f64"));
    accepts(inFn("return 1.9 as i32 + 1;"));
  });

  test("casts only convert between numbers", () => {
    rejects(inFn("return true as i32;"), /cannot cast bool to i32/);
  });

  test("comparing different numeric types is an error", () => {
    rejects(inFn("return 1 < 1.5;", "bool"), /same type/);
  });
});

describe("conditions and logic", () => {
  test("if and while need a bool", () => {
    accepts(inFn("if true { return 1; } return 0;"));
    rejects(inFn("if 1 { return 1; } return 0;"), /condition of 'if' must be bool/);
    rejects(inFn("while 1 { } return 0;"), /condition of 'while' must be bool/);
  });

  test("there is no truthiness, and the error says so", () => {
    try {
      check(parse(inFn("if 1 { return 1; } return 0;")));
      assert.fail("expected a type error");
    } catch (error) {
      assert.ok(error instanceof NibError);
      assert.match(error.diagnostic.help ?? "", /x != 0/);
    }
  });

  test("&& and || need bools on both sides", () => {
    accepts(inFn("return true && false;", "bool"));
    rejects(inFn("return 1 && true;", "bool"), /expects bool on both sides/);
  });

  test("! needs a bool", () => {
    rejects(inFn("return !1;", "bool"), /'!' expects bool/);
  });

  test("equality needs matching types", () => {
    accepts(inFn("return true == false;", "bool"));
    rejects(inFn("return 1 == true;", "bool"), /cannot compare i32 with bool/);
  });

  test("% is restricted to i32", () => {
    accepts(inFn("return 7 % 2;"));
    rejects(inFn("return 7.0 % 2.0;", "f64"), /only defined for i32/);
  });
});

describe("variables", () => {
  test("rejects an unknown variable", () => {
    rejects(inFn("return nope;"), /cannot find variable 'nope'/);
  });

  test("rejects assigning to an immutable binding", () => {
    rejects(inFn("let x = 1; x = 2; return x;"), /not mutable/);
  });

  test("accepts assigning to a mutable binding", () => {
    accepts(inFn("let mut x = 1; x = 2; return x;"));
  });

  test("assignment must keep the type", () => {
    rejects(inFn("let mut x = 1; x = true; return x;"), /cannot assign bool/);
  });

  test("rejects a redeclaration in the same scope", () => {
    rejects(inFn("let x = 1; let x = 2; return x;"), /already declared in this scope/);
  });

  test("an inner block may shadow an outer name", () => {
    accepts(inFn("let x = 1; if true { let x = 2; } return x;"));
  });

  test("a variable does not escape its block", () => {
    rejects(inFn("if true { let x = 1; } return x;"), /cannot find variable 'x'/);
  });

  test("params are visible and immutable", () => {
    accepts("fn f(a: i32) -> i32 { return a; }");
    rejects("fn f(a: i32) -> i32 { a = 1; return a; }", /not mutable/);
  });
});

describe("functions", () => {
  test("checks arity", () => {
    rejects("fn g(a: i32) -> i32 { return a; } fn f() -> i32 { return g(); }", /takes 1 argument\(s\), found 0/);
  });

  test("checks argument types", () => {
    rejects("fn g(a: i32) -> i32 { return a; } fn f() -> i32 { return g(true); }", /argument 1 of 'g' is i32/);
  });

  test("recursion is allowed", () => {
    accepts("fn f(n: i32) -> i32 { if n < 2 { return n; } return f(n - 1); }");
  });

  test("rejects duplicate function names", () => {
    rejects("fn f() { } fn f() { }", /declared more than once/);
  });

  test("rejects duplicate parameter names", () => {
    rejects("fn f(a: i32, a: i32) { }", /parameter 'a' is declared more than once/);
  });

  test("a variable used as a function gets a pointed hint", () => {
    try {
      check(parse("fn f() -> i32 { let g = 1; return g(); }"));
      assert.fail("expected a type error");
    } catch (error) {
      assert.ok(error instanceof NibError);
      assert.match(error.diagnostic.help ?? "", /is a variable, not a function/);
    }
  });

  test("a function used as a value gets a pointed hint", () => {
    try {
      check(parse("fn g() -> i32 { return 1; } fn f() -> i32 { return g; }"));
      assert.fail("expected a type error");
    } catch (error) {
      assert.ok(error instanceof NibError);
      assert.match(error.diagnostic.help ?? "", /call it with g\(\.\.\.\)/);
    }
  });
});

describe("returns", () => {
  test("the value must match the declared return type", () => {
    rejects(inFn("return true;"), /expected this function to return i32/);
  });

  test("a function returning nothing cannot return a value", () => {
    rejects("fn f() { return 1; }", /returns nothing/);
  });

  test("a function with a return type needs a value", () => {
    rejects(inFn("return;"), /needs a value/);
  });

  test("every path must return", () => {
    rejects(inFn("if true { return 1; }"), /must return i32 on every path/);
    accepts(inFn("if true { return 1; } else { return 2; }"));
    accepts(inFn("if true { return 1; } return 2;"));
  });

  test("a while loop does not count as a returning path", () => {
    rejects(inFn("while true { return 1; }"), /must return i32 on every path/);
  });

  test("an else-if chain counts only when it ends in an else", () => {
    accepts(inFn("if true { return 1; } else if false { return 2; } else { return 3; }"));
    rejects(inFn("if true { return 1; } else if false { return 2; }"), /every path/);
  });

  test("a function returning nothing needs no return", () => {
    accepts("fn f() { let x = 1; }");
  });
});

describe("statements", () => {
  test("only a call may stand alone as a statement", () => {
    accepts("fn g() { } fn f() { g(); }");
    rejects("fn f() { 1 + 1; }", /computed and thrown away/);
  });

  test("cannot bind the result of a function that returns nothing", () => {
    rejects("fn g() { } fn f() { let x = g(); }", /returns nothing/);
  });
});

describe("side tables", () => {
  test("every expression gets a type", () => {
    const module = parse("fn f(a: i32) -> i32 { let b = a * 2; return b; }");
    const checked = check(module);
    // The four expression nodes are `a`, `2`, `a * 2` and the `b` in `return b`.
    assert.equal(checked.exprTypes.size, 4);
    const [a, two, product, b] = [...checked.exprTypes.values()];
    assert.deepEqual([a, two, product, b], ["i32", "i32", "i32", "i32"]);
  });

  test("params take the first slots, then locals in declaration order", () => {
    const module = parse("fn f(a: i32, b: i32) -> i32 { let c = 1; let d = 2; return c + d; }");
    const checked = check(module);
    const fn = checked.functions[0]!;

    assert.deepEqual(fn.locals, ["i32", "i32"]);

    const lets = module.functions[0]!.body.stmts.filter((stmt) => stmt.kind === "let");
    assert.deepEqual(
      lets.map((stmt) => checked.slots.get(stmt)),
      [2, 3],
    );
  });

  test("signatures record exports", () => {
    const checked = check(parse("export fn a() { } fn b() { }"));
    assert.deepEqual(
      checked.functions.map((fn) => [fn.signature.name, fn.signature.exported]),
      [
        ["a", true],
        ["b", false],
      ],
    );
  });
});

describe("integer literal range", () => {
  test("accepts the i32 boundaries", () => {
    accepts(inFn("return 2147483647;"));
    accepts(inFn("return -2147483648;"));
  });

  test("rejects a literal that does not fit", () => {
    rejects(inFn("return 2147483648;"), /does not fit in an i32/);
    rejects(inFn("return -2147483649;"), /does not fit in an i32/);
  });

  test("a minus sign is folded into the literal", () => {
    const module = parse(inFn("return -5;"));
    const returned = module.functions[0]!.body.stmts[0]!;
    assert.equal(returned.kind, "return");
    assert.equal(returned.value?.kind, "int");
  });
});
