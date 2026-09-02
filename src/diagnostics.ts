/**
 * Source positions and error reporting.
 *
 * Every token, node and type error carries a {@link Span} back to the exact
 * bytes it came from. A compiler that can only say "syntax error" is a
 * compiler nobody wants to use, so spans are threaded through the whole
 * pipeline rather than bolted on at the end.
 */

/** A half-open byte range `[start, end)` into the source text. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export function span(start: number, end: number): Span {
  return { start, end };
}

/** Merge two spans into the smallest span covering both. */
export function joinSpans(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

export type Phase = "lex" | "parse" | "check" | "emit";

export interface Diagnostic {
  readonly phase: Phase;
  readonly message: string;
  readonly span: Span;
  /** Optional second line of advice, shown under the caret. */
  readonly help?: string;
}

export interface Position {
  /** 1-based. */
  readonly line: number;
  /** 1-based, counted in UTF-16 code units. */
  readonly column: number;
}

/** Convert a byte offset into a 1-based line and column. */
export function positionOf(source: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: clamped - lineStart + 1 };
}

function lineTextAt(source: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let start = clamped;
  while (start > 0 && source[start - 1] !== "\n") start--;
  let end = clamped;
  while (end < source.length && source[end] !== "\n") end++;
  return source.slice(start, end);
}

/**
 * Render a diagnostic the way a compiler should: the offending line, a caret
 * under the exact span, and the file and position on the first line.
 */
export function renderDiagnostic(diagnostic: Diagnostic, source: string, fileName = "<input>"): string {
  const { line, column } = positionOf(source, diagnostic.span.start);
  const text = lineTextAt(source, diagnostic.span.start);
  const gutter = String(line);
  const pad = " ".repeat(gutter.length);

  const width = Math.max(1, Math.min(diagnostic.span.end - diagnostic.span.start, text.length - column + 1));
  const caret = " ".repeat(Math.max(0, column - 1)) + "^".repeat(width);

  const lines = [
    `${fileName}:${line}:${column}: ${diagnostic.phase} error: ${diagnostic.message}`,
    `${pad} |`,
    `${gutter} | ${text}`,
    `${pad} | ${caret}`,
  ];
  if (diagnostic.help !== undefined) lines.push(`${pad} = help: ${diagnostic.help}`);
  return lines.join("\n");
}

/** Thrown by every phase. Carries the span so the CLI can render it properly. */
export class NibError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "NibError";
    this.diagnostic = diagnostic;
  }

  static at(phase: Phase, message: string, at: Span, help?: string): NibError {
    return new NibError(help === undefined ? { phase, message, span: at } : { phase, message, span: at, help });
  }
}
