#!/usr/bin/env node
/** The `nib` command. */

import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import process from "node:process";

import { compileOrExplain } from "./compile.js";
import { printModule } from "./print.js";
import { instantiate } from "./run.js";

const USAGE = `nib — a small statically-typed language that compiles to WebAssembly

usage:
  nib run <file.nib> [args...]   compile, instantiate, and call an export
  nib build <file.nib> [-o out]  write a .wasm file
  nib check <file.nib>           parse and type-check only
  nib ast <file.nib>             print the parsed syntax tree

options:
  --export <name>   which function to call (default: main)
  -o, --output      output path for 'build' (default: alongside the input)
  -h, --help        show this message
`;

const EXIT_OK = 0;
const EXIT_COMPILE_ERROR = 1;
const EXIT_USAGE = 2;

interface Options {
  readonly command: string;
  readonly file: string;
  readonly exportName: string;
  readonly output: string | undefined;
  readonly args: readonly number[];
}

function parseArgs(argv: readonly string[]): Options {
  const [command, file, ...rest] = argv;
  if (command === undefined || file === undefined) {
    throw new Error("expected a command and a file");
  }

  let exportName = "main";
  let output: string | undefined;
  const args: number[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--export") {
      const value = rest[++i];
      if (value === undefined) throw new Error("--export needs a function name");
      exportName = value;
    } else if (arg === "-o" || arg === "--output") {
      const value = rest[++i];
      if (value === undefined) throw new Error("-o needs a path");
      output = value;
    } else {
      const value = Number(arg);
      if (!Number.isFinite(value)) throw new Error(`expected a number, found '${arg}'`);
      args.push(value);
    }
  }

  return { command, file, exportName, output, args };
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? EXIT_USAGE : EXIT_OK;
  }

  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`nib: ${(error as Error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  let source: string;
  try {
    source = await readFile(options.file, "utf8");
  } catch {
    process.stderr.write(`nib: cannot read ${options.file}\n`);
    return EXIT_USAGE;
  }

  const compiled = compileOrExplain(source, options.file);
  if (!compiled.ok) {
    process.stderr.write(`${compiled.message}\n`);
    return EXIT_COMPILE_ERROR;
  }
  const { ast, wasm } = compiled.result;

  switch (options.command) {
    case "check":
      process.stdout.write(`ok: ${options.file} type-checks\n`);
      return EXIT_OK;

    case "ast":
      process.stdout.write(`${printModule(ast)}\n`);
      return EXIT_OK;

    case "build": {
      const output = options.output ?? `${basename(options.file, extname(options.file))}.wasm`;
      await writeFile(output, wasm);
      process.stdout.write(`wrote ${output} (${wasm.length} bytes)\n`);
      return EXIT_OK;
    }

    case "run": {
      const instance = await instantiate(wasm);
      try {
        const result = instance.call(options.exportName, ...options.args);
        if (result !== undefined) process.stdout.write(`${result}\n`);
        return EXIT_OK;
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError) {
          process.stderr.write(`nib: trapped at run time: ${error.message}\n`);
          return EXIT_COMPILE_ERROR;
        }
        process.stderr.write(`nib: ${(error as Error).message}\n`);
        return EXIT_USAGE;
      }
    }

    default:
      process.stderr.write(`nib: unknown command '${options.command}'\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
