/**
 * Walks the checked AST and emits a WebAssembly module.
 *
 * Two details are worth knowing before reading this:
 *
 * 1. wasm has no jumps, only structured control flow. A `while` loop becomes a
 *    `block` wrapping a `loop`, where breaking out is a branch to the block
 *    and continuing is a branch to the loop. Branch targets are counted
 *    outwards from the innermost enclosing construct, which is why the depths
 *    below are 1 and 0 rather than labels.
 *
 * 2. A function whose body always returns explicitly still has to satisfy the
 *    validator at its implicit end, where the stack looks empty. Emitting
 *    `unreachable` there is the standard way to say "control never gets here".
 */

import type { Block, Expr, Identifier, LetStmt, Stmt } from "./ast.js";
import type { CheckedFn, CheckedModule } from "./checker.js";
import { NibError, type Span } from "./diagnostics.js";
import type { Type, ValueType } from "./types.js";
import {
  encodeName,
  f64Bytes,
  MAGIC,
  section,
  SectionId,
  sleb128,
  uleb128,
  vector,
  VERSION,
  type Bytes,
} from "./wasm/encoding.js";
import { BlockType, EXPORT_FUNC, FUNC_TYPE, Op, ValType } from "./wasm/opcodes.js";

/** bool is represented as i32, which is also what wasm comparisons produce. */
function valTypeOf(type: ValueType): number {
  return type === "f64" ? ValType.f64 : ValType.i32;
}

export function emit(checked: CheckedModule): Uint8Array {
  const indices = new Map<string, number>();
  checked.functions.forEach((fn, index) => indices.set(fn.signature.name, index));

  const types: Bytes[] = checked.functions.map((fn) => [
    FUNC_TYPE,
    ...vector(fn.signature.params.map((param) => [valTypeOf(param)])),
    ...vector(fn.signature.result === "void" ? [] : [[valTypeOf(fn.signature.result)]]),
  ]);

  // One type per function: nib has no overloading, so deduplicating the type
  // section would save a handful of bytes and cost clarity.
  const funcs: Bytes[] = checked.functions.map((_, index) => uleb128(index));

  const exports: Bytes[] = checked.functions
    .filter((fn) => fn.signature.exported)
    .map((fn) => [...encodeName(fn.signature.name), EXPORT_FUNC, ...uleb128(indices.get(fn.signature.name)!)]);

  const codes: Bytes[] = checked.functions.map((fn) => encodeFunctionBody(fn, checked, indices));

  return new Uint8Array([
    ...MAGIC,
    ...VERSION,
    ...section(SectionId.type, vector(types)),
    ...section(SectionId.function, vector(funcs)),
    ...section(SectionId.export, vector(exports)),
    ...section(SectionId.code, vector(codes)),
  ]);
}

function encodeFunctionBody(
  fn: CheckedFn,
  checked: CheckedModule,
  indices: ReadonlyMap<string, number>,
): Bytes {
  const emitter = new BodyEmitter(checked, indices);
  const body = emitter.block(fn.decl.body);

  if (fn.signature.result !== "void") body.push(Op.unreachable);
  body.push(Op.end);

  const code = [...compressLocals(fn.locals), ...body];
  return [...uleb128(code.length), ...code];
}

/** Locals are declared as runs of `(count, type)` rather than one entry each. */
function compressLocals(locals: readonly ValueType[]): Bytes {
  const runs: Bytes[] = [];
  let index = 0;

  while (index < locals.length) {
    const type = locals[index]!;
    let count = 1;
    while (index + count < locals.length && locals[index + count] === type) count++;
    runs.push([...uleb128(count), valTypeOf(type)]);
    index += count;
  }

  return vector(runs);
}

class BodyEmitter {
  constructor(
    private readonly checked: CheckedModule,
    private readonly indices: ReadonlyMap<string, number>,
  ) {}

  private typeOf(expr: Expr): Type {
    const type = this.checked.exprTypes.get(expr);
    if (type === undefined) {
      throw NibError.at("emit", "internal error: expression was never type-checked", expr.span);
    }
    return type;
  }

  private slotOf(node: Identifier | LetStmt, span: Span): number {
    const slot = this.checked.slots.get(node);
    if (slot === undefined) {
      throw NibError.at("emit", "internal error: variable was never resolved", span);
    }
    return slot;
  }

  block(block: Block): Bytes {
    return block.stmts.flatMap((stmt) => this.stmt(stmt));
  }

  private stmt(stmt: Stmt): Bytes {
    switch (stmt.kind) {
      case "let":
        return [...this.expr(stmt.value), Op.local_set, ...uleb128(this.slotOf(stmt, stmt.span))];

      case "assign":
        return [
          ...this.expr(stmt.value),
          Op.local_set,
          ...uleb128(this.slotOf(stmt.target, stmt.target.span)),
        ];

      case "return":
        return stmt.value === undefined ? [Op.return] : [...this.expr(stmt.value), Op.return];

      case "if":
        return this.ifStmt(stmt);

      case "while":
        return [
          Op.block,
          BlockType.void,
          Op.loop,
          BlockType.void,
          // Branch out of the enclosing block when the condition is false.
          ...this.expr(stmt.condition),
          Op.i32_eqz,
          Op.br_if,
          ...uleb128(1),
          ...this.block(stmt.body),
          // ...otherwise jump back to the top of the loop.
          Op.br,
          ...uleb128(0),
          Op.end,
          Op.end,
        ];

      case "expr": {
        const code = this.expr(stmt.expr);
        // A call used as a statement leaves its result on the stack.
        if (this.typeOf(stmt.expr) !== "void") code.push(Op.drop);
        return code;
      }
    }
  }

  private ifStmt(stmt: Extract<Stmt, { kind: "if" }>): Bytes {
    const code: Bytes = [...this.expr(stmt.condition), Op.if, BlockType.void, ...this.block(stmt.then)];

    if (stmt.otherwise !== undefined) {
      code.push(Op.else);
      code.push(...("stmts" in stmt.otherwise ? this.block(stmt.otherwise) : this.stmt(stmt.otherwise)));
    }

    code.push(Op.end);
    return code;
  }

  private expr(expr: Expr): Bytes {
    switch (expr.kind) {
      case "int":
        return [Op.i32_const, ...sleb128(expr.value)];

      case "float":
        return [Op.f64_const, ...f64Bytes(expr.value)];

      case "bool":
        return [Op.i32_const, ...sleb128(expr.value ? 1 : 0)];

      case "identifier":
        return [Op.local_get, ...uleb128(this.slotOf(expr, expr.span))];

      case "call": {
        const index = this.indices.get(expr.callee.name);
        if (index === undefined) {
          throw NibError.at("emit", `internal error: unresolved call to '${expr.callee.name}'`, expr.span);
        }
        return [...expr.args.flatMap((arg) => this.expr(arg)), Op.call, ...uleb128(index)];
      }

      case "cast": {
        const from = this.typeOf(expr.operand);
        const to = this.typeOf(expr);
        const code = this.expr(expr.operand);
        if (from === to) return code;
        code.push(to === "f64" ? Op.f64_convert_i32_s : Op.i32_trunc_f64_s);
        return code;
      }

      case "unary": {
        if (expr.op === "!") return [...this.expr(expr.operand), Op.i32_eqz];
        // wasm has no i32.neg, so negation is a subtraction from zero.
        if (this.typeOf(expr.operand) === "f64") return [...this.expr(expr.operand), Op.f64_neg];
        return [Op.i32_const, ...sleb128(0), ...this.expr(expr.operand), Op.i32_sub];
      }

      case "binary":
        return this.binary(expr);
    }
  }

  private binary(expr: Extract<Expr, { kind: "binary" }>): Bytes {
    // && and || must not evaluate the right side unless they have to, so they
    // compile to a branch rather than to an arithmetic instruction.
    if (expr.op === "&&") {
      return [
        ...this.expr(expr.left),
        Op.if,
        BlockType.i32,
        ...this.expr(expr.right),
        Op.else,
        Op.i32_const,
        ...sleb128(0),
        Op.end,
      ];
    }

    if (expr.op === "||") {
      return [
        ...this.expr(expr.left),
        Op.if,
        BlockType.i32,
        Op.i32_const,
        ...sleb128(1),
        Op.else,
        ...this.expr(expr.right),
        Op.end,
      ];
    }

    const operandType = this.typeOf(expr.left);
    const opcode = arithmeticOpcode(expr.op, operandType, expr);
    return [...this.expr(expr.left), ...this.expr(expr.right), opcode];
  }
}

function arithmeticOpcode(op: string, operandType: Type, expr: Expr): number {
  const isFloat = operandType === "f64";

  switch (op) {
    case "+":
      return isFloat ? Op.f64_add : Op.i32_add;
    case "-":
      return isFloat ? Op.f64_sub : Op.i32_sub;
    case "*":
      return isFloat ? Op.f64_mul : Op.i32_mul;
    case "/":
      return isFloat ? Op.f64_div : Op.i32_div_s;
    case "%":
      return Op.i32_rem_s;
    case "==":
      return isFloat ? Op.f64_eq : Op.i32_eq;
    case "!=":
      return isFloat ? Op.f64_ne : Op.i32_ne;
    case "<":
      return isFloat ? Op.f64_lt : Op.i32_lt_s;
    case "<=":
      return isFloat ? Op.f64_le : Op.i32_le_s;
    case ">":
      return isFloat ? Op.f64_gt : Op.i32_gt_s;
    case ">=":
      return isFloat ? Op.f64_ge : Op.i32_ge_s;
    default:
      throw NibError.at("emit", `internal error: no opcode for '${op}'`, expr.span);
  }
}
