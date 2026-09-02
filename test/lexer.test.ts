import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { NibError, positionOf, renderDiagnostic } from "../src/diagnostics.js";
import { tokenize, type TokenKind } from "../src/lexer.js";

const kinds = (source: string): TokenKind[] => tokenize(source).map((token) => token.kind);
const texts = (source: string): string[] => tokenize(source).map((token) => token.text);

describe("lexer", () => {
  test("tokenises a whole function", () => {
    assert.deepEqual(kinds("fn add(a: i32) -> i32 { return a + 1; }"), [
      "fn",
      "ident",
      "(",
      "ident",
      ":",
      "ident",
      ")",
      "->",
      "ident",
      "{",
      "return",
      "ident",
      "+",
      "int",
      ";",
      "}",
      "eof",
    ]);
  });

  test("always ends with a single eof token", () => {
    assert.deepEqual(kinds(""), ["eof"]);
    assert.equal(tokenize("1 2 3").filter((t) => t.kind === "eof").length, 1);
  });

  test("recognises every keyword", () => {
    assert.deepEqual(kinds("fn export let mut if else while return true false as"), [
      "fn",
      "export",
      "let",
      "mut",
      "if",
      "else",
      "while",
      "return",
      "true",
      "false",
      "as",
      "eof",
    ]);
  });

  test("keywords must be whole words", () => {
    assert.deepEqual(kinds("iffy lettuce returned"), ["ident", "ident", "ident", "eof"]);
  });

  test("prefers the longest operator", () => {
    assert.deepEqual(kinds("== = != ! <= < >= > && || -> -"), [
      "==",
      "=",
      "!=",
      "!",
      "<=",
      "<",
      ">=",
      ">",
      "&&",
      "||",
      "->",
      "-",
      "eof",
    ]);
  });

  test("separates integers from floats", () => {
    assert.deepEqual(kinds("1 1.5 1e3 1.5e-3 1E+2"), ["int", "float", "float", "float", "float", "eof"]);
  });

  test("a trailing dot is not part of the number", () => {
    // `1.` would be ambiguous with a future member access, so the dot is left
    // for the next rule to reject rather than being swallowed here.
    assert.throws(() => tokenize("1."), NibError);
  });

  test("strips digit separators from the token text", () => {
    assert.deepEqual(texts("1_000_000"), ["1000000", ""]);
    assert.deepEqual(texts("1_0.5_0"), ["10.50", ""]);
  });

  test("rejects a number ending in a separator", () => {
    assert.throws(() => tokenize("100_"), /digit separator/);
  });

  test("an exponent marker without digits is not consumed", () => {
    assert.deepEqual(kinds("1e"), ["int", "ident", "eof"]);
  });

  test("skips line comments", () => {
    assert.deepEqual(kinds("1 // 2 3\n4"), ["int", "int", "eof"]);
  });

  test("skips block comments and lets them nest", () => {
    assert.deepEqual(kinds("1 /* 2 /* 3 */ 4 */ 5"), ["int", "int", "eof"]);
  });

  test("rejects an unterminated block comment", () => {
    assert.throws(() => tokenize("1 /* 2"), /unterminated block comment/);
  });

  test("rejects an unknown character", () => {
    assert.throws(() => tokenize("a @ b"), /unexpected character/);
  });

  test("spans point back at the exact source text", () => {
    const source = "let total = 42;";
    const token = tokenize(source).find((t) => t.kind === "int");
    assert.ok(token);
    assert.equal(source.slice(token.span.start, token.span.end), "42");
  });
});

describe("diagnostics", () => {
  test("positions are 1-based on both axes", () => {
    const source = "fn a()\nfn b()";
    assert.deepEqual(positionOf(source, 0), { line: 1, column: 1 });
    assert.deepEqual(positionOf(source, 7), { line: 2, column: 1 });
    assert.deepEqual(positionOf(source, 10), { line: 2, column: 4 });
  });

  test("renders the offending line with a caret under the span", () => {
    const source = "let x = 1;\nlet y = @;";
    let rendered = "";
    try {
      tokenize(source);
    } catch (error) {
      assert.ok(error instanceof NibError);
      rendered = renderDiagnostic(error.diagnostic, source, "demo.nib");
    }

    assert.equal(
      rendered,
      [
        'demo.nib:2:9: lex error: unexpected character "@"',
        "  |",
        "2 | let y = @;",
        "  |         ^",
      ].join("\n"),
    );
  });
});
