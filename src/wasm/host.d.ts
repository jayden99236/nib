/**
 * The host's WebAssembly namespace, declared to exactly the surface nib uses.
 *
 * TypeScript ships these types only in `lib.dom.d.ts`, and pulling in the
 * whole DOM to get them would put `document` and `window` in scope for a
 * command-line compiler. Declaring the four things we actually touch is
 * smaller, and it documents the host contract in one place.
 */

declare namespace WebAssembly {
  type Bytes = ArrayBuffer | ArrayBufferView;

  class Module {
    constructor(bytes: Bytes);
  }

  class Instance {
    readonly exports: Record<string, unknown>;
  }

  class CompileError extends Error {}
  class LinkError extends Error {}
  class RuntimeError extends Error {}

  function validate(bytes: Bytes): boolean;
  function instantiate(bytes: Bytes): Promise<{ module: Module; instance: Instance }>;
}
