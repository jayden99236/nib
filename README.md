# nib

[![CI](https://github.com/jayden99236/nib/actions/workflows/ci.yml/badge.svg)](https://github.com/jayden99236/nib/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024-blue)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A small statically-typed language that compiles to WebAssembly. Lexer, parser,
type checker and binary emitter, written from scratch in TypeScript with no
dependencies — the wasm bytes are assembled by hand, not by a backend library.

```
source ──▶ lexer ──▶ parser ──▶ checker ──▶ emitter ──▶ .wasm ──▶ any wasm engine
            tokens     AST      side tables   bytes
```

## A program

```rust
fn fib(n: i32) -> i32 {
  if n < 2 {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

export fn main() -> i32 {
  let mut total = 0;
  let mut i = 0;

  while i < 20 {
    total = total + fib(i);
    i = i + 1;
  }

  return total;
}
```

```console
$ nib run examples/fib.nib
10945

$ nib build examples/fib.nib -o fib.wasm
wrote fib.wasm (118 bytes)
```

That `.wasm` is an ordinary module. Nothing about nib is involved in running it:

```js
const { instance } = await WebAssembly.instantiate(await readFile("fib.wasm"));
instance.exports.main(); // 10945
```

## Install

```bash
git clone https://github.com/jayden99236/nib.git
cd nib
npm install
npm run build
node dist/src/cli.js run examples/fib.nib
```

## Commands

```
nib run <file.nib> [args...]   compile, instantiate, and call an export
nib build <file.nib> [-o out]  write a .wasm file
nib check <file.nib>           parse and type-check only
nib ast <file.nib>             print the parsed syntax tree

--export <name>   which function to call (default: main)
```

Exit status is `0` on success, `1` on a compile error or a run-time trap, `2`
on a usage error.

## The language

Three types — `i32`, `f64`, `bool` — plus functions, `let` and `let mut`,
`if`/`else if`/`else`, `while`, `return`, and calls including recursion and
mutual recursion. `export fn` makes a function visible to the host.

Two decisions are worth calling out, because both of them are the reason
something later is simple.

**No implicit conversions.** `1 + 1.0` is an error, not a silent widening:

```
example.nib:2:10: check error: '+' expects both sides to be the same type, found i32 and f64
  |
2 |   return 1 + 1.5;
  |          ^^^^^^^
  = help: nib has no implicit conversions; add an explicit cast, as in 'x as f64'
```

The cost is a few `as f64` casts in user code. The gain is that every
expression has exactly one type by the time the emitter sees it, so choosing
between `i32.add` and `f64.add` is a lookup rather than an inference problem.

**No truthiness.** `if x` on an integer is an error; conditions are `bool` or
nothing. Since wasm represents `bool` as `i32` anyway, this costs nothing at
run time and removes a whole category of quiet mistakes.

## How it works

**Lexer** — a flat token stream. Nested block comments, digit separators
(`1_000_000`), longest-match operators. Every token carries the byte range it
came from, and those spans are threaded through every later phase, which is why
errors can point at the exact expression rather than the line.

**Parser** — recursive descent with precedence climbing. All thirteen binary
operators come from one table and one loop, so precedence is data rather than a
tower of functions. Assignment is a statement, not an expression, which makes
`if x = 1` a parse error instead of a bug. A leading minus is folded into
numeric literals, so `-2147483648` never passes through a positive literal that
does not fit in an i32.

**Checker** — resolves names, checks types, and allocates the wasm local slots
in the same pass. It emits *side tables* keyed by AST node — a type for every
expression, a slot for every variable reference — rather than building a second
tree, so the emitter never redoes scope analysis. Return-path analysis is
deliberately conservative: `while true { return 1; }` is rejected, because
proving it terminates is worth more machinery than it saves.

**Emitter** — writes the binary format directly: LEB128 integers, the four
sections nib needs, IEEE-754 immediates. The interesting parts are the places
where wasm's structure does not match the source:

- wasm has no jumps, so `while` becomes a `block` wrapping a `loop`, where
  exiting is a branch to depth 1 and continuing a branch to depth 0.
- `&&` and `||` have to short-circuit, so they compile to a typed `if` block
  rather than to an arithmetic instruction.
- There is no `i32.neg`, so `-x` is a subtraction from zero.
- A function whose every path returns still needs something at its implicit
  end to satisfy the validator, which is what the trailing `unreachable` is
  for.

## Tests

156 tests, run against Node 20, 22 and 24.

The compiler tests do not compare against snapshots of the emitted bytes. They
hand the output to the engine and call it:

```ts
test("mutual recursion", async () => {
  const source = `
    fn is_even(n: i32) -> bool { if n == 0 { return true; } return is_odd(n - 1); }
    fn is_odd(n: i32) -> bool { if n == 0 { return false; } return is_even(n - 1); }
    export fn main(n: i32) -> bool { return is_even(n); }
  `;
  assert.equal(await runModule(source, 10), 1);
});
```

If the emitter produces bytes wasm will not accept, instantiation throws and the
test fails. A snapshot would happily record the broken output instead. The
three example programs are executed by CI too, so a codegen regression that
still validates but returns the wrong number is caught as well.

```bash
npm test      # build, then run the suite
npm run check # tsc --noEmit, strict
```

## What is not here

No strings, arrays, structs or heap of any kind — nib never touches wasm linear
memory, which keeps the emitter to one file. No modules or imports, no
closures, no generics, no optimiser: the emitted code is a direct translation
of the source. Adding memory is the obvious next step, and everything above is
arranged so that it would be an addition rather than a rewrite.

## Licence

MIT — see [LICENSE](LICENSE).
