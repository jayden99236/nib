import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { NibError } from "../src/diagnostics.js";
import { parse, parseExpression } from "../src/parser.js";
import { printExpr, printModule } from "../src/print.js";

const expr = (source: string): string => printExpr(parseExpression(source));

describe("expression precedence", () => {
  test("multiplication binds tighter than addition", () => {
    assert.equal(expr("1 + 2 * 3"), "(+ 1 (* 2 3))");
    assert.equal(expr("1 * 2 + 3"), "(+ (* 1 2) 3)");
  });

  test("parentheses override precedence", () => {
    assert.equal(expr("(1 + 2) * 3"), "(* (+ 1 2) 3)");
  });

  test("arithmetic is left-associative", () => {
    assert.equal(expr("1 - 2 - 3"), "(- (- 1 2) 3)");
    assert.equal(expr("8 / 4 / 2"), "(/ (/ 8 4) 2)");
  });

  test("comparison is looser than arithmetic", () => {
    assert.equal(expr("a + 1 < b * 2"), "(< (+ a 1) (* b 2))");
  });

  test("equality is looser than comparison", () => {
    assert.equal(expr("a < b == c < d"), "(== (< a b) (< c d))");
  });

  test("&& binds tighter than ||", () => {
    assert.equal(expr("a || b && c"), "(|| a (&& b c))");
    assert.equal(expr("a && b || c"), "(|| (&& a b) c)");
  });

  test("logical operators are looser than comparison", () => {
    assert.equal(expr("a < b && c > d"), "(&& (< a b) (> c d))");
  });

  test("unary binds tighter than binary", () => {
    assert.equal(expr("-a + b"), "(+ (- a) b)");
    assert.equal(expr("!a && b"), "(&& (! a) b)");
  });

  test("unary operators stack", () => {
    assert.equal(expr("- - a"), "(- (- a))");
  });

  test("a cast binds tighter than arithmetic but looser than unary", () => {
    assert.equal(expr("a as f64 * b"), "(* (as a f64) b)");
    assert.equal(expr("-a as f64"), "(as (- a) f64)");
  });

  test("casts chain left to right", () => {
    assert.equal(expr("a as f64 as i32"), "(as (as a f64) i32)");
  });

  test("calls parse with any number of arguments", () => {
    assert.equal(expr("f()"), "(call f)");
    assert.equal(expr("f(1)"), "(call f 1)");
    assert.equal(expr("f(1, 2 + 3)"), "(call f 1 (+ 2 3))");
    assert.equal(expr("f(g(1), 2)"), "(call f (call g 1) 2)");
  });

  test("a trailing comma in an argument list is allowed", () => {
    assert.equal(expr("f(1, 2,)"), "(call f 1 2)");
  });

  test("literals keep their kind", () => {
    assert.equal(expr("true"), "true");
    assert.equal(expr("1.5"), "1.5");
    assert.equal(expr("1_000"), "1000");
  });
});

describe("declarations", () => {
  test("parses a function with params and a return type", () => {
    assert.equal(
      printModule(parse("fn add(a: i32, b: i32) -> i32 { return a + b; }")),
      "(fn add (a:i32 b:i32) -> i32 (block (return (+ a b))))",
    );
  });

  test("parses an exported function with no params", () => {
    assert.equal(printModule(parse("export fn main() -> i32 { return 1; }")), "(export fn main () -> i32 (block (return 1)))");
  });

  test("a missing return type means the function returns nothing", () => {
    assert.equal(printModule(parse("fn noop() { }")), "(fn noop () (block))");
  });

  test("parses several functions in one module", () => {
    assert.equal(parse("fn a() { } fn b() { }").functions.length, 2);
  });

  test("a trailing comma in a parameter list is allowed", () => {
    assert.equal(parse("fn f(a: i32,) { }").functions[0]?.params.length, 1);
  });
});

describe("statements", () => {
  test("let with and without a type annotation", () => {
    assert.equal(printModule(parse("fn f() { let x = 1; }")), "(fn f () (block (let x 1)))");
    assert.equal(printModule(parse("fn f() { let x: f64 = 1.0; }")), "(fn f () (block (let x:f64 1)))");
  });

  test("let mut is distinct from let", () => {
    assert.equal(printModule(parse("fn f() { let mut x = 1; }")), "(fn f () (block (let mut x 1)))");
  });

  test("assignment", () => {
    assert.equal(printModule(parse("fn f() { x = 2; }")), "(fn f () (block (= x 2)))");
  });

  test("return with and without a value", () => {
    assert.equal(printModule(parse("fn f() { return; }")), "(fn f () (block (return)))");
    assert.equal(printModule(parse("fn f() { return 1; }")), "(fn f () (block (return 1)))");
  });

  test("if with an else block", () => {
    assert.equal(
      printModule(parse("fn f() { if a { return 1; } else { return 2; } }")),
      "(fn f () (block (if a (block (return 1)) (block (return 2)))))",
    );
  });

  test("else if chains without extra nesting in the source", () => {
    assert.equal(
      printModule(parse("fn f() { if a { } else if b { } else { } }")),
      "(fn f () (block (if a (block) (if b (block) (block)))))",
    );
  });

  test("while", () => {
    assert.equal(printModule(parse("fn f() { while a < 10 { a = a + 1; } }")), "(fn f () (block (while (< a 10) (block (= a (+ a 1))))))");
  });

  test("a call can stand alone as a statement", () => {
    assert.equal(printModule(parse("fn f() { g(1); }")), "(fn f () (block (call g 1)))");
  });
});

describe("parse errors", () => {
  const fails = (source: string, pattern: RegExp): void => {
    assert.throws(() => parse(source), pattern);
  };

  test("assignment is a statement, so it cannot appear in a condition", () => {
    fails("fn f() { if x = 1 { } }", /expected '\{' to open a block/);
  });

  test("reports a missing semicolon", () => {
    fails("fn f() { let x = 1 }", /expected ';'/);
  });

  test("reports an unclosed paren", () => {
    fails("fn f() { let x = (1; }", /expected '\)'/);
  });

  test("reports a missing function body", () => {
    fails("fn f()", /expected '\{'/);
  });

  test("rejects assigning to something that is not a variable", () => {
    fails("fn f() { 1 = 2; }", /left side of an assignment/);
  });

  test("reports an empty expression", () => {
    fails("fn f() { let x = ; }", /expected an expression/);
  });

  test("errors carry a span pointing at the offending token", () => {
    const source = "fn f() { let x = 1 }";
    try {
      parse(source);
      assert.fail("expected a parse error");
    } catch (error) {
      assert.ok(error instanceof NibError);
      assert.equal(source.slice(error.diagnostic.span.start, error.diagnostic.span.end), "}");
    }
  });
});
