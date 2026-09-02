/** Instantiating and calling a compiled nib module from JavaScript. */

import { compile } from "./compile.js";

export type NibValue = number | boolean;

export interface NibInstance {
  readonly exports: Record<string, (...args: number[]) => number | undefined>;
  call(name: string, ...args: number[]): number | undefined;
}

/** Instantiate compiled bytes. Throws if wasm rejects the module. */
export async function instantiate(wasm: Uint8Array): Promise<NibInstance> {
  // Copy into a fresh buffer: a Uint8Array view over a larger pool is legal
  // here but makes for confusing failures if the caller reuses it.
  const { instance } = await WebAssembly.instantiate(Uint8Array.from(wasm));
  const exports = instance.exports as Record<string, (...args: number[]) => number | undefined>;

  return {
    exports,
    call(name, ...args) {
      const fn = exports[name];
      if (typeof fn !== "function") {
        throw new Error(`'${name}' is not an exported function of this module`);
      }
      return fn(...args);
    },
  };
}

/** Convenience for tests and the CLI: source in, running instance out. */
export async function compileAndInstantiate(source: string): Promise<NibInstance> {
  return instantiate(compile(source).wasm);
}
