/**
 * Resolves names, checks types, and allocates local slots.
 *
 * The checker is where nib's one opinionated rule lives: there are no implicit
 * numeric conversions. `1 + 1.0` is an error, not a silent widening. That
 * costs a few casts in user code and buys the emitter total certainty about
 * which opcode to reach for, since every expression has exactly one type.
 *
 * The output is deliberately not a new tree. It is a set of side tables keyed
 * by the AST nodes themselves, so the emitter can ask "what type is this
 * expression" and "which slot is this variable" without redoing scope
 * analysis.
 */

import type { Block, Expr, FnDecl, Identifier, LetStmt, Module, Stmt, TypeRef } from "./ast.js";
import { NibError, type Span } from "./diagnostics.js";
import { isNumeric, isValueTypeName, type FnSignature, type Type, type ValueType } from "./types.js";

export interface CheckedFn {
  readonly decl: FnDecl;
  readonly signature: FnSignature;
  /** Types of the locals declared inside the body, in slot order after the params. */
  readonly locals: readonly ValueType[];
}

export interface CheckedModule {
  readonly functions: readonly CheckedFn[];
  /** Type of every expression in the module. */
  readonly exprTypes: ReadonlyMap<Expr, Type>;
  /** Local slot index for every variable reference and assignment target. */
  readonly slots: ReadonlyMap<Identifier | LetStmt, number>;
}

interface Variable {
  readonly type: ValueType;
  readonly mutable: boolean;
  readonly slot: number;
}

/** Declared as a function so TypeScript narrows control flow after a call. */
function fail(message: string, at: Span, help?: string): never {
  throw NibError.at("check", message, at, help);
}

export function check(module: Module): CheckedModule {
  const signatures = collectSignatures(module);
  const exprTypes = new Map<Expr, Type>();
  const slots = new Map<Identifier | LetStmt, number>();

  const functions = module.functions.map((decl) =>
    new FunctionChecker(decl, signatures, exprTypes, slots).run(),
  );

  return { functions, exprTypes, slots };
}

function resolveTypeRef(ref: TypeRef): ValueType {
  if (!isValueTypeName(ref.name)) {
    return fail(`unknown type '${ref.name}'`, ref.span, "nib has i32, f64 and bool");
  }
  return ref.name;
}

function collectSignatures(module: Module): Map<string, FnSignature> {
  const signatures = new Map<string, FnSignature>();

  for (const decl of module.functions) {
    if (signatures.has(decl.name)) {
      fail(`function '${decl.name}' is declared more than once`, decl.nameSpan);
    }

    const seen = new Set<string>();
    for (const param of decl.params) {
      if (seen.has(param.name)) {
        fail(`parameter '${param.name}' is declared more than once`, param.span);
      }
      seen.add(param.name);
    }

    signatures.set(decl.name, {
      name: decl.name,
      params: decl.params.map((param) => resolveTypeRef(param.declared)),
      result: decl.returns === undefined ? "void" : resolveTypeRef(decl.returns),
      exported: decl.exported,
    });
  }

  return signatures;
}

class FunctionChecker {
  private readonly scopes: Map<string, Variable>[] = [];
  private readonly locals: ValueType[] = [];
  private nextSlot = 0;

  constructor(
    private readonly decl: FnDecl,
    private readonly signatures: ReadonlyMap<string, FnSignature>,
    private readonly exprTypes: Map<Expr, Type>,
    private readonly slots: Map<Identifier | LetStmt, number>,
  ) {}

  private get signature(): FnSignature {
    return this.signatures.get(this.decl.name)!;
  }

  run(): CheckedFn {
    this.scopes.push(new Map());

    this.decl.params.forEach((param, index) => {
      const type = this.signature.params[index]!;
      this.declare(param.name, { type, mutable: false, slot: this.nextSlot++ }, param.span);
    });

    this.checkBlock(this.decl.body);

    if (this.signature.result !== "void" && !alwaysReturns(this.decl.body)) {
      fail(
        `function '${this.decl.name}' must return ${this.signature.result} on every path`,
        this.decl.body.span,
        "add a return at the end of the body, or give every branch of the final if its own return",
      );
    }

    this.scopes.pop();
    return { decl: this.decl, signature: this.signature, locals: this.locals };
  }

  // ------------------------------------------------------------ environment

  private declare(name: string, variable: Variable, at: Span): void {
    const scope = this.scopes[this.scopes.length - 1]!;
    if (scope.has(name)) {
      fail(`'${name}' is already declared in this scope`, at);
    }
    scope.set(name, variable);
  }

  private lookup(name: string): Variable | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const found = this.scopes[i]!.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // ------------------------------------------------------------- statements

  private checkBlock(block: Block): void {
    this.scopes.push(new Map());
    for (const stmt of block.stmts) this.checkStmt(stmt);
    this.scopes.pop();
  }

  private checkStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "let":
        return this.checkLet(stmt);

      case "assign": {
        const variable = this.lookup(stmt.target.name);
        if (variable === undefined) {
          fail(`cannot find variable '${stmt.target.name}'`, stmt.target.span);
          return;
        }
        if (!variable.mutable) {
          fail(
            `cannot assign to '${stmt.target.name}' because it is not mutable`,
            stmt.target.span,
            `declare it as 'let mut ${stmt.target.name}'`,
          );
        }
        this.slots.set(stmt.target, variable.slot);
        this.exprTypes.set(stmt.target, variable.type);

        const valueType = this.checkExpr(stmt.value);
        if (valueType !== variable.type) {
          fail(
            `cannot assign ${describe(valueType)} to '${stmt.target.name}', which is ${variable.type}`,
            stmt.value.span,
          );
        }
        return;
      }

      case "return": {
        const expected = this.signature.result;
        if (stmt.value === undefined) {
          if (expected !== "void") {
            fail(`this function returns ${expected}, so 'return' needs a value`, stmt.span);
          }
          return;
        }
        const actual = this.checkExpr(stmt.value);
        if (expected === "void") {
          fail(`function '${this.decl.name}' returns nothing, so it cannot return a value`, stmt.value.span);
        }
        if (actual !== expected) {
          fail(`expected this function to return ${expected}, found ${describe(actual)}`, stmt.value.span);
        }
        return;
      }

      case "if": {
        this.checkCondition(stmt.condition, "if");
        this.checkBlock(stmt.then);
        if (stmt.otherwise !== undefined) {
          if ("stmts" in stmt.otherwise) this.checkBlock(stmt.otherwise);
          else this.checkStmt(stmt.otherwise);
        }
        return;
      }

      case "while": {
        this.checkCondition(stmt.condition, "while");
        this.checkBlock(stmt.body);
        return;
      }

      case "expr": {
        if (stmt.expr.kind !== "call") {
          fail(
            "this expression is computed and thrown away",
            stmt.expr.span,
            "only a call can stand alone as a statement",
          );
        }
        this.checkExpr(stmt.expr);
        return;
      }
    }
  }

  private checkLet(stmt: LetStmt): void {
    const valueType = this.checkExpr(stmt.value);

    if (valueType === "void") {
      fail("cannot bind the result of a function that returns nothing", stmt.value.span);
    }

    let type = valueType as ValueType;
    if (stmt.declared !== undefined) {
      const declared = resolveTypeRef(stmt.declared);
      if (declared !== valueType) {
        fail(
          `'${stmt.name}' is declared ${declared} but the initialiser is ${describe(valueType)}`,
          stmt.value.span,
          declared === "f64" && valueType === "i32"
            ? "nib has no implicit conversions; write the literal as 1.0, or cast with 'as f64'"
            : undefined,
        );
      }
      type = declared;
    }

    const slot = this.nextSlot++;
    this.locals.push(type);
    this.slots.set(stmt, slot);
    this.declare(stmt.name, { type, mutable: stmt.mutable, slot }, stmt.nameSpan);
  }

  private checkCondition(condition: Expr, keyword: string): void {
    const type = this.checkExpr(condition);
    if (type !== "bool") {
      fail(
        `the condition of '${keyword}' must be bool, found ${describe(type)}`,
        condition.span,
        type === "i32" ? "nib has no truthiness; compare explicitly, as in 'x != 0'" : undefined,
      );
    }
  }

  // ------------------------------------------------------------ expressions

  private checkExpr(expr: Expr): Type {
    const type = this.inferExpr(expr);
    this.exprTypes.set(expr, type);
    return type;
  }

  private inferExpr(expr: Expr): Type {
    switch (expr.kind) {
      case "int": {
        // Checked here rather than in the parser so that the parser has
        // already folded any leading minus into the literal.
        if (expr.value < -2_147_483_648 || expr.value > 2_147_483_647) {
          fail(`integer literal ${expr.value} does not fit in an i32`, expr.span, "i32 holds -2147483648 to 2147483647");
        }
        return "i32";
      }
      case "float":
        return "f64";
      case "bool":
        return "bool";

      case "identifier": {
        const variable = this.lookup(expr.name);
        if (variable === undefined) {
          const help = this.signatures.has(expr.name) ? `'${expr.name}' is a function; call it with ${expr.name}(...)` : undefined;
          return fail(`cannot find variable '${expr.name}'`, expr.span, help);
        }
        this.slots.set(expr, variable.slot);
        return variable.type;
      }

      case "unary": {
        const operand = this.checkExpr(expr.operand);
        if (expr.op === "!") {
          if (operand !== "bool") fail(`'!' expects bool, found ${describe(operand)}`, expr.operand.span);
          return "bool";
        }
        if (!isNumeric(operand)) fail(`unary '-' expects a number, found ${describe(operand)}`, expr.operand.span);
        return operand;
      }

      case "binary":
        return this.inferBinary(expr);

      case "cast": {
        const from = this.checkExpr(expr.operand);
        const to = resolveTypeRef(expr.target);
        if (!isNumeric(from) || !isNumeric(to)) {
          fail(`cannot cast ${describe(from)} to ${to}`, expr.span, "casts convert between i32 and f64");
        }
        return to;
      }

      case "call": {
        const signature = this.signatures.get(expr.callee.name);
        if (signature === undefined) {
          const help = this.lookup(expr.callee.name) !== undefined ? `'${expr.callee.name}' is a variable, not a function` : undefined;
          return fail(`cannot find function '${expr.callee.name}'`, expr.callee.span, help);
        }

        if (expr.args.length !== signature.params.length) {
          fail(
            `'${signature.name}' takes ${signature.params.length} argument(s), found ${expr.args.length}`,
            expr.span,
          );
        }

        expr.args.forEach((arg, index) => {
          const actual = this.checkExpr(arg);
          const expected = signature.params[index]!;
          if (actual !== expected) {
            fail(`argument ${index + 1} of '${signature.name}' is ${expected}, found ${describe(actual)}`, arg.span);
          }
        });

        return signature.result;
      }
    }
  }

  private inferBinary(expr: Extract<Expr, { kind: "binary" }>): Type {
    const left = this.checkExpr(expr.left);
    const right = this.checkExpr(expr.right);

    switch (expr.op) {
      case "&&":
      case "||": {
        if (left !== "bool" || right !== "bool") {
          fail(`'${expr.op}' expects bool on both sides, found ${describe(left)} and ${describe(right)}`, expr.span);
        }
        return "bool";
      }

      case "==":
      case "!=": {
        if (left !== right) fail(`cannot compare ${describe(left)} with ${describe(right)}`, expr.span);
        if (left === "void") fail("cannot compare values of a function that returns nothing", expr.span);
        return "bool";
      }

      case "<":
      case "<=":
      case ">":
      case ">=": {
        this.requireSameNumber(expr.op, left, right, expr.span);
        return "bool";
      }

      case "%": {
        this.requireSameNumber(expr.op, left, right, expr.span);
        if (left !== "i32") {
          fail("'%' is only defined for i32", expr.span, "WebAssembly has no floating-point remainder instruction");
        }
        return "i32";
      }

      default: {
        this.requireSameNumber(expr.op, left, right, expr.span);
        return left;
      }
    }
  }

  private requireSameNumber(op: string, left: Type, right: Type, at: Span): void {
    if (!isNumeric(left) || !isNumeric(right)) {
      fail(`'${op}' expects numbers, found ${describe(left)} and ${describe(right)}`, at);
    }
    if (left !== right) {
      fail(
        `'${op}' expects both sides to be the same type, found ${describe(left)} and ${describe(right)}`,
        at,
        "nib has no implicit conversions; add an explicit cast, as in 'x as f64'",
      );
    }
  }
}

function describe(type: Type): string {
  return type === "void" ? "nothing" : type;
}

/**
 * Conservative return-path analysis: a block returns if any statement in it
 * definitely returns, and an `if` returns only when it has an else and both
 * sides return. `while` never counts, even `while true`, because proving that
 * needs more machinery than it is worth here.
 */
export function alwaysReturns(block: Block): boolean {
  return block.stmts.some(stmtAlwaysReturns);
}

function stmtAlwaysReturns(stmt: Stmt): boolean {
  if (stmt.kind === "return") return true;
  if (stmt.kind !== "if") return false;
  if (stmt.otherwise === undefined) return false;

  const elseReturns = "stmts" in stmt.otherwise ? alwaysReturns(stmt.otherwise) : stmtAlwaysReturns(stmt.otherwise);
  return alwaysReturns(stmt.then) && elseReturns;
}
