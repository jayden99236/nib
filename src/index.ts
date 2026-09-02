/** Public API. The CLI is a thin wrapper over exactly these functions. */

export type * from "./ast.js";
export { alwaysReturns, check, type CheckedFn, type CheckedModule } from "./checker.js";
export { compile, compileOrExplain, type CompileResult } from "./compile.js";
export {
  joinSpans,
  NibError,
  positionOf,
  renderDiagnostic,
  span,
  type Diagnostic,
  type Phase,
  type Position,
  type Span,
} from "./diagnostics.js";
export { emit } from "./emitter.js";
export { tokenize, type Token, type TokenKind } from "./lexer.js";
export { parse, parseExpression } from "./parser.js";
export { printBlock, printExpr, printFn, printModule, printStmt } from "./print.js";
export { compileAndInstantiate, instantiate, type NibInstance } from "./run.js";
export { isNumeric, isValueTypeName, type FnSignature, type NumericType, type Type, type ValueType } from "./types.js";
