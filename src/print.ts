/**
 * Renders an AST as parenthesised text.
 *
 * This exists so parser tests can assert on shape — `(+ 1 (* 2 3))` — instead
 * of comparing nested object literals, which makes a precedence bug obvious
 * at a glance rather than something you decode from a diff.
 */

import type { Block, Expr, FnDecl, Module, Stmt } from "./ast.js";

export function printExpr(expr: Expr): string {
  switch (expr.kind) {
    case "int":
    case "float":
      return String(expr.value);
    case "bool":
      return expr.value ? "true" : "false";
    case "identifier":
      return expr.name;
    case "unary":
      return `(${expr.op} ${printExpr(expr.operand)})`;
    case "binary":
      return `(${expr.op} ${printExpr(expr.left)} ${printExpr(expr.right)})`;
    case "cast":
      return `(as ${printExpr(expr.operand)} ${expr.target.name})`;
    case "call":
      return `(call ${expr.callee.name}${expr.args.map((arg) => ` ${printExpr(arg)}`).join("")})`;
  }
}

export function printStmt(stmt: Stmt): string {
  switch (stmt.kind) {
    case "let": {
      const mut = stmt.mutable ? " mut" : "";
      const type = stmt.declared === undefined ? "" : `:${stmt.declared.name}`;
      return `(let${mut} ${stmt.name}${type} ${printExpr(stmt.value)})`;
    }
    case "assign":
      return `(= ${stmt.target.name} ${printExpr(stmt.value)})`;
    case "return":
      return stmt.value === undefined ? "(return)" : `(return ${printExpr(stmt.value)})`;
    case "if": {
      const otherwise =
        stmt.otherwise === undefined
          ? ""
          : ` ${"stmts" in stmt.otherwise ? printBlock(stmt.otherwise) : printStmt(stmt.otherwise)}`;
      return `(if ${printExpr(stmt.condition)} ${printBlock(stmt.then)}${otherwise})`;
    }
    case "while":
      return `(while ${printExpr(stmt.condition)} ${printBlock(stmt.body)})`;
    case "expr":
      return printExpr(stmt.expr);
  }
}

export function printBlock(block: Block): string {
  return `(block${block.stmts.map((stmt) => ` ${printStmt(stmt)}`).join("")})`;
}

export function printFn(fn: FnDecl): string {
  const params = fn.params.map((param) => `${param.name}:${param.declared.name}`).join(" ");
  const returns = fn.returns === undefined ? "" : ` -> ${fn.returns.name}`;
  const exported = fn.exported ? "export " : "";
  return `(${exported}fn ${fn.name} (${params})${returns} ${printBlock(fn.body)})`;
}

export function printModule(module: Module): string {
  return module.functions.map(printFn).join("\n");
}
