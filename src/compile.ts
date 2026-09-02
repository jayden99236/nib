/** The whole pipeline in one place: text in, WebAssembly bytes out. */

import type { Module } from "./ast.js";
import { check, type CheckedModule } from "./checker.js";
import { NibError, renderDiagnostic } from "./diagnostics.js";
import { emit } from "./emitter.js";
import { parse } from "./parser.js";

export interface CompileResult {
  readonly ast: Module;
  readonly checked: CheckedModule;
  readonly wasm: Uint8Array;
}

export function compile(source: string): CompileResult {
  const ast = parse(source);
  const checked = check(ast);
  return { ast, checked, wasm: emit(checked) };
}

/** Compile, and on failure return the error already rendered for a terminal. */
export function compileOrExplain(
  source: string,
  fileName: string,
): { ok: true; result: CompileResult } | { ok: false; message: string } {
  try {
    return { ok: true, result: compile(source) };
  } catch (error) {
    if (error instanceof NibError) {
      return { ok: false, message: renderDiagnostic(error.diagnostic, source, fileName) };
    }
    throw error;
  }
}
