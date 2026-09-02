/** The subset of WebAssembly instructions and type codes that nib emits. */

export const ValType = {
  i32: 0x7f,
  f64: 0x7c,
} as const;

/** Block type immediates: void, or a single result. */
export const BlockType = {
  void: 0x40,
  i32: 0x7f,
} as const;

export const FUNC_TYPE = 0x60;
export const EXPORT_FUNC = 0x00;

export const Op = {
  unreachable: 0x00,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  br_if: 0x0d,
  return: 0x0f,
  call: 0x10,
  drop: 0x1a,

  local_get: 0x20,
  local_set: 0x21,

  i32_const: 0x41,
  f64_const: 0x44,

  i32_eqz: 0x45,
  i32_eq: 0x46,
  i32_ne: 0x47,
  i32_lt_s: 0x48,
  i32_gt_s: 0x4a,
  i32_le_s: 0x4c,
  i32_ge_s: 0x4e,

  f64_eq: 0x61,
  f64_ne: 0x62,
  f64_lt: 0x63,
  f64_gt: 0x64,
  f64_le: 0x65,
  f64_ge: 0x66,

  i32_add: 0x6a,
  i32_sub: 0x6b,
  i32_mul: 0x6c,
  i32_div_s: 0x6d,
  i32_rem_s: 0x6f,

  f64_neg: 0x9a,
  f64_add: 0xa0,
  f64_sub: 0xa1,
  f64_mul: 0xa2,
  f64_div: 0xa3,

  i32_trunc_f64_s: 0xaa,
  f64_convert_i32_s: 0xb7,
} as const;
