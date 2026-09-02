/** nib's type universe. Small on purpose — see the README for what is out. */

export type NumericType = "i32" | "f64";
export type ValueType = NumericType | "bool";
export type Type = ValueType | "void";

export interface FnSignature {
  readonly name: string;
  readonly params: readonly ValueType[];
  readonly result: Type;
  readonly exported: boolean;
}

const TYPE_NAMES = new Set<string>(["i32", "f64", "bool"]);

export function isValueTypeName(name: string): name is ValueType {
  return TYPE_NAMES.has(name);
}

export function isNumeric(type: Type): type is NumericType {
  return type === "i32" || type === "f64";
}
