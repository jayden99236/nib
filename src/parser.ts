/**
 * A recursive-descent parser with precedence climbing for expressions.
 *
 * Binary operators are handled by one table-driven loop rather than one
 * function per precedence level, so adding an operator means adding a row to
 * {@link BINARY_PRECEDENCE} and nothing else.
 */

import type {
  AssignStmt,
  BinaryOp,
  Block,
  Expr,
  FnDecl,
  Identifier,
  IfStmt,
  Module,
  Param,
  Stmt,
  TypeRef,
  UnaryOp,
} from "./ast.js";
import { joinSpans, NibError } from "./diagnostics.js";
import { tokenize, type Token, type TokenKind } from "./lexer.js";

/** Higher binds tighter. `as` sits between unary and `*`, as in Rust. */
const BINARY_PRECEDENCE: ReadonlyMap<TokenKind, number> = new Map([
  ["||", 1],
  ["&&", 2],
  ["==", 3],
  ["!=", 3],
  ["<", 4],
  ["<=", 4],
  [">", 4],
  [">=", 4],
  ["+", 5],
  ["-", 5],
  ["*", 6],
  ["/", 6],
  ["%", 6],
]);

export function parse(source: string): Module {
  return new Parser(tokenize(source)).parseModule();
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  // ---------------------------------------------------------------- helpers

  private get current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private at(kind: TokenKind): boolean {
    return this.current.kind === kind;
  }

  private advance(): Token {
    const token = this.current;
    if (token.kind !== "eof") this.index++;
    return token;
  }

  private eat(kind: TokenKind): boolean {
    if (!this.at(kind)) return false;
    this.advance();
    return true;
  }

  private expect(kind: TokenKind, context: string): Token {
    if (this.at(kind)) return this.advance();
    const found = this.current.kind === "eof" ? "end of file" : `'${this.current.text}'`;
    throw NibError.at("parse", `expected '${kind}' ${context}, found ${found}`, this.current.span);
  }

  // ---------------------------------------------------------------- module

  parseModule(): Module {
    const functions: FnDecl[] = [];
    while (!this.at("eof")) functions.push(this.parseFn());
    return { functions };
  }

  private parseFn(): FnDecl {
    const start = this.current.span;
    const exported = this.eat("export");
    this.expect("fn", exported ? "after 'export'" : "at the start of a declaration");

    const nameToken = this.expect("ident", "after 'fn'");
    this.expect("(", "after the function name");

    const params: Param[] = [];
    while (!this.at(")")) {
      const paramName = this.expect("ident", "in the parameter list");
      this.expect(":", "after the parameter name");
      const declared = this.parseTypeRef();
      params.push({ name: paramName.text, declared, span: joinSpans(paramName.span, declared.span) });
      if (!this.eat(",")) break;
    }
    this.expect(")", "to close the parameter list");

    const returns = this.eat("->") ? this.parseTypeRef() : undefined;
    const body = this.parseBlock();

    return {
      name: nameToken.text,
      nameSpan: nameToken.span,
      exported,
      params,
      returns,
      body,
      span: joinSpans(start, body.span),
    };
  }

  private parseTypeRef(): TypeRef {
    const token = this.expect("ident", "where a type was expected");
    return { name: token.text, span: token.span };
  }

  // ------------------------------------------------------------ statements

  private parseBlock(): Block {
    const open = this.expect("{", "to open a block");
    const stmts: Stmt[] = [];
    while (!this.at("}") && !this.at("eof")) stmts.push(this.parseStmt());
    const close = this.expect("}", "to close the block");
    return { stmts, span: joinSpans(open.span, close.span) };
  }

  private parseStmt(): Stmt {
    switch (this.current.kind) {
      case "let":
        return this.parseLet();
      case "return":
        return this.parseReturn();
      case "if":
        return this.parseIf();
      case "while":
        return this.parseWhile();
      default:
        return this.parseAssignOrExpr();
    }
  }

  private parseLet(): Stmt {
    const start = this.advance().span;
    const mutable = this.eat("mut");
    const name = this.expect("ident", "after 'let'");
    const declared = this.eat(":") ? this.parseTypeRef() : undefined;
    this.expect("=", "in a let statement");
    const value = this.parseExpr();
    const end = this.expect(";", "after a let statement");
    return {
      kind: "let",
      name: name.text,
      nameSpan: name.span,
      mutable,
      declared,
      value,
      span: joinSpans(start, end.span),
    };
  }

  private parseReturn(): Stmt {
    const start = this.advance().span;
    const value = this.at(";") ? undefined : this.parseExpr();
    const end = this.expect(";", "after a return statement");
    return { kind: "return", value, span: joinSpans(start, end.span) };
  }

  private parseIf(): IfStmt {
    const start = this.advance().span;
    const condition = this.parseExpr();
    const then = this.parseBlock();

    let otherwise: Block | IfStmt | undefined;
    if (this.eat("else")) {
      otherwise = this.at("if") ? this.parseIf() : this.parseBlock();
    }

    const end = otherwise === undefined ? then.span : otherwise.span;
    return { kind: "if", condition, then, otherwise, span: joinSpans(start, end) };
  }

  private parseWhile(): Stmt {
    const start = this.advance().span;
    const condition = this.parseExpr();
    const body = this.parseBlock();
    return { kind: "while", condition, body, span: joinSpans(start, body.span) };
  }

  /**
   * Assignment is a statement, not an expression, which is what makes
   * `if x = 1 { }` a parse error here instead of a runtime surprise later.
   */
  private parseAssignOrExpr(): Stmt {
    const expr = this.parseExpr();

    if (this.eat("=")) {
      if (expr.kind !== "identifier") {
        throw NibError.at("parse", "left side of an assignment must be a variable", expr.span);
      }
      const value = this.parseExpr();
      const end = this.expect(";", "after an assignment");
      const assign: AssignStmt = {
        kind: "assign",
        target: expr,
        value,
        span: joinSpans(expr.span, end.span),
      };
      return assign;
    }

    const end = this.expect(";", "after an expression statement");
    return { kind: "expr", expr, span: joinSpans(expr.span, end.span) };
  }

  // ----------------------------------------------------------- expressions

  parseExpr(): Expr {
    return this.parseBinary(0);
  }

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseCast();

    for (;;) {
      const precedence = BINARY_PRECEDENCE.get(this.current.kind);
      if (precedence === undefined || precedence < minPrecedence) return left;

      const op = this.advance();
      // Every binary operator in nib is left-associative, so the right side is
      // parsed at one level tighter.
      const right = this.parseBinary(precedence + 1);
      left = {
        kind: "binary",
        op: op.kind as BinaryOp,
        left,
        right,
        span: joinSpans(left.span, right.span),
      };
    }
  }

  private parseCast(): Expr {
    let expr = this.parseUnary();
    while (this.eat("as")) {
      const target = this.parseTypeRef();
      expr = { kind: "cast", operand: expr, target, span: joinSpans(expr.span, target.span) };
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.at("-") || this.at("!")) {
      const op = this.advance();
      const operand = this.parseUnary();

      // Fold a minus sign directly into a numeric literal. Without this,
      // -2147483648 would have to pass through the positive literal
      // 2147483648, which does not fit in an i32 and would be rejected.
      if (op.kind === "-" && (operand.kind === "int" || operand.kind === "float")) {
        return { kind: operand.kind, value: -operand.value, span: joinSpans(op.span, operand.span) };
      }

      return {
        kind: "unary",
        op: op.kind as UnaryOp,
        operand,
        span: joinSpans(op.span, operand.span),
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.current;

    switch (token.kind) {
      case "int": {
        this.advance();
        const value = Number(token.text);
        if (!Number.isSafeInteger(value)) {
          throw NibError.at("parse", `integer literal ${token.text} is out of range`, token.span);
        }
        return { kind: "int", value, span: token.span };
      }

      case "float": {
        this.advance();
        return { kind: "float", value: Number(token.text), span: token.span };
      }

      case "true":
      case "false": {
        this.advance();
        return { kind: "bool", value: token.kind === "true", span: token.span };
      }

      case "ident": {
        this.advance();
        const identifier: Identifier = { kind: "identifier", name: token.text, span: token.span };
        if (!this.at("(")) return identifier;
        return this.parseCallArgs(identifier);
      }

      case "(": {
        this.advance();
        const inner = this.parseExpr();
        this.expect(")", "to close a parenthesised expression");
        return inner;
      }

      default: {
        const found = token.kind === "eof" ? "end of file" : `'${token.text}'`;
        throw NibError.at("parse", `expected an expression, found ${found}`, token.span);
      }
    }
  }

  private parseCallArgs(callee: Identifier): Expr {
    this.expect("(", "to open an argument list");
    const args: Expr[] = [];
    while (!this.at(")")) {
      args.push(this.parseExpr());
      if (!this.eat(",")) break;
    }
    const close = this.expect(")", "to close the argument list");
    return { kind: "call", callee, args, span: joinSpans(callee.span, close.span) };
  }
}

/** Exposed for tests and the `nib ast` command: parse one expression. */
export function parseExpression(source: string): Expr {
  return new Parser(tokenize(source)).parseExpr();
}
