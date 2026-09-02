/** The syntax tree the parser produces and every later phase walks. */

import type { Span } from "./diagnostics.js";

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

export type UnaryOp = "-" | "!";

/** A type as written in the source. Resolved to a real type by the checker. */
export interface TypeRef {
  readonly name: string;
  readonly span: Span;
}

export interface IntLiteral {
  readonly kind: "int";
  readonly value: number;
  readonly span: Span;
}

export interface FloatLiteral {
  readonly kind: "float";
  readonly value: number;
  readonly span: Span;
}

export interface BoolLiteral {
  readonly kind: "bool";
  readonly value: boolean;
  readonly span: Span;
}

export interface Identifier {
  readonly kind: "identifier";
  readonly name: string;
  readonly span: Span;
}

export interface Unary {
  readonly kind: "unary";
  readonly op: UnaryOp;
  readonly operand: Expr;
  readonly span: Span;
}

export interface Binary {
  readonly kind: "binary";
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
  readonly span: Span;
}

export interface Call {
  readonly kind: "call";
  readonly callee: Identifier;
  readonly args: readonly Expr[];
  readonly span: Span;
}

/** `value as f64` — nib has no implicit numeric conversions. */
export interface Cast {
  readonly kind: "cast";
  readonly operand: Expr;
  readonly target: TypeRef;
  readonly span: Span;
}

export type Expr = IntLiteral | FloatLiteral | BoolLiteral | Identifier | Unary | Binary | Call | Cast;

export interface LetStmt {
  readonly kind: "let";
  readonly name: string;
  readonly nameSpan: Span;
  readonly mutable: boolean;
  /** Absent when the type is inferred from the initialiser. */
  readonly declared: TypeRef | undefined;
  readonly value: Expr;
  readonly span: Span;
}

export interface AssignStmt {
  readonly kind: "assign";
  readonly target: Identifier;
  readonly value: Expr;
  readonly span: Span;
}

export interface ReturnStmt {
  readonly kind: "return";
  readonly value: Expr | undefined;
  readonly span: Span;
}

export interface IfStmt {
  readonly kind: "if";
  readonly condition: Expr;
  readonly then: Block;
  readonly otherwise: Block | IfStmt | undefined;
  readonly span: Span;
}

export interface WhileStmt {
  readonly kind: "while";
  readonly condition: Expr;
  readonly body: Block;
  readonly span: Span;
}

/** A call evaluated for its effect; the value, if any, is discarded. */
export interface ExprStmt {
  readonly kind: "expr";
  readonly expr: Expr;
  readonly span: Span;
}

export type Stmt = LetStmt | AssignStmt | ReturnStmt | IfStmt | WhileStmt | ExprStmt;

export interface Block {
  readonly stmts: readonly Stmt[];
  readonly span: Span;
}

export interface Param {
  readonly name: string;
  readonly declared: TypeRef;
  readonly span: Span;
}

export interface FnDecl {
  readonly name: string;
  readonly nameSpan: Span;
  readonly exported: boolean;
  readonly params: readonly Param[];
  /** Absent for a function that returns nothing. */
  readonly returns: TypeRef | undefined;
  readonly body: Block;
  readonly span: Span;
}

export interface Module {
  readonly functions: readonly FnDecl[];
}
