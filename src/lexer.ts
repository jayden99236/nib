/** Turns source text into a flat token stream. */

import { NibError, span, type Span } from "./diagnostics.js";

export type TokenKind =
  // literals and names
  | "int"
  | "float"
  | "ident"
  // keywords
  | "fn"
  | "export"
  | "let"
  | "mut"
  | "if"
  | "else"
  | "while"
  | "return"
  | "true"
  | "false"
  | "as"
  // punctuation
  | "("
  | ")"
  | "{"
  | "}"
  | ","
  | ":"
  | ";"
  | "->"
  // operators
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "="
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "!"
  | "eof";

export interface Token {
  readonly kind: TokenKind;
  /** The exact source text, minus digit separators for numbers. */
  readonly text: string;
  readonly span: Span;
}

const KEYWORDS = new Map<string, TokenKind>([
  ["fn", "fn"],
  ["export", "export"],
  ["let", "let"],
  ["mut", "mut"],
  ["if", "if"],
  ["else", "else"],
  ["while", "while"],
  ["return", "return"],
  ["true", "true"],
  ["false", "false"],
  ["as", "as"],
]);

/**
 * Two-character operators must be tried before their one-character prefixes,
 * so this table is ordered longest-first and matched in order.
 */
const OPERATORS: readonly TokenKind[] = [
  "->",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "(",
  ")",
  "{",
  "}",
  ",",
  ":",
  ";",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
  "<",
  ">",
  "!",
];

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const peek = (offset = 0): string => source[i + offset] ?? "";

  while (i < source.length) {
    const ch = peek();

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    if (ch === "/" && peek(1) === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    // Block comments nest, so `/* /* */ */` closes once rather than leaving a
    // stray `*/`. Commenting out a region that already has comments in it is
    // the whole point of having them.
    if (ch === "/" && peek(1) === "*") {
      const start = i;
      let depth = 0;
      while (i < source.length) {
        if (peek() === "/" && peek(1) === "*") {
          depth++;
          i += 2;
        } else if (peek() === "*" && peek(1) === "/") {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      if (depth !== 0) {
        throw NibError.at("lex", "unterminated block comment", span(start, start + 2));
      }
      continue;
    }

    if (isDigit(ch)) {
      tokens.push(readNumber(source, i));
      i = tokens[tokens.length - 1]!.span.end;
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i]!)) i++;
      const text = source.slice(start, i);
      tokens.push({ kind: KEYWORDS.get(text) ?? "ident", text, span: span(start, i) });
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (operator !== undefined) {
      tokens.push({ kind: operator, text: operator, span: span(i, i + operator.length) });
      i += operator.length;
      continue;
    }

    throw NibError.at("lex", `unexpected character ${JSON.stringify(ch)}`, span(i, i + 1));
  }

  tokens.push({ kind: "eof", text: "", span: span(source.length, source.length) });
  return tokens;
}

/**
 * Read a numeric literal. A literal is a float when it carries a decimal point
 * or an exponent; underscores are allowed as digit separators and stripped
 * from the token text so later phases can parse it directly.
 */
function readNumber(source: string, start: number): Token {
  let i = start;
  let isFloat = false;

  const digits = (): void => {
    while (i < source.length && (isDigit(source[i]!) || source[i] === "_")) i++;
  };

  digits();

  if (source[i] === "." && isDigit(source[i + 1] ?? "")) {
    isFloat = true;
    i++;
    digits();
  }

  if (source[i] === "e" || source[i] === "E") {
    const mark = i;
    let j = i + 1;
    if (source[j] === "+" || source[j] === "-") j++;
    if (isDigit(source[j] ?? "")) {
      isFloat = true;
      i = j;
      digits();
    } else {
      i = mark;
    }
  }

  const raw = source.slice(start, i);
  if (raw.endsWith("_")) {
    throw NibError.at("lex", "number cannot end with a digit separator", span(start, i));
  }

  return { kind: isFloat ? "float" : "int", text: raw.replace(/_/g, ""), span: span(start, i) };
}
