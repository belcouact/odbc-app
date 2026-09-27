/**
 * A tiny formula engine for the results grid's "calculated column" feature.
 *
 * Formulas reference source columns with `{ColumnName}` and support arithmetic
 * (`+ - * / % ^`), comparison (`= == != < <= > >=`), string concatenation
 * (`&`) and a small set of scalar functions (ABS, ROUND, IF, UPPER, ...).
 * Aggregates are intentionally omitted — each computed cell maps to one row.
 */

/** A user-added computed column shown in the grid. */
export interface ComputedColumn {
  name: string
  expression: string
}

/** A runtime value produced by the formula engine. */
type Value = number | string | boolean | null

/** Raised for any syntax / evaluation problem, with an optional char offset. */
export class FormulaError extends Error {
  pos?: number
  constructor(message: string, pos?: number) {
    super(message)
    this.name = 'FormulaError'
    this.pos = pos
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = 'number' | 'string' | 'column' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof'

interface Token {
  type: TokenType
  text: string
  pos: number
  value?: number
}

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '%', '^', '&', '=', '!', '<', '>', '(', ')', ','])

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const ch = input[i]

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    // String literal: 'text' or "text"
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let str = ''
      while (j < input.length && input[j] !== quote) {
        str += input[j]
        j++
      }
      if (j >= input.length) throw new FormulaError('Unterminated string literal', i)
      tokens.push({ type: 'string', text: str, pos: i })
      i = j + 1
      continue
    }

    // Number (integer or decimal)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i
      while (j < input.length && /[0-9.]/.test(input[j])) j++
      const num = Number(input.slice(i, j))
      if (!Number.isFinite(num)) throw new FormulaError(`Invalid number '${input.slice(i, j)}'`, i)
      tokens.push({ type: 'number', text: input.slice(i, j), pos: i, value: num })
      i = j
      continue
    }

    // Column reference: {ColumnName}
    if (ch === '{') {
      const end = input.indexOf('}', i + 1)
      if (end === -1) throw new FormulaError("Missing '}' in column reference", i)
      const name = input.slice(i + 1, end).trim()
      if (!name) throw new FormulaError('Empty column reference', i)
      tokens.push({ type: 'column', text: name, pos: i })
      i = end + 1
      continue
    }

    // Identifier (function name)
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++
      tokens.push({ type: 'ident', text: input.slice(i, j), pos: i })
      i = j
      continue
    }

    // Operators / punctuation
    if (OPERATOR_CHARS.has(ch)) {
      const two = input.slice(i, i + 2)
      if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ type: 'op', text: two, pos: i })
        i += 2
        continue
      }
      if (ch === '(') {
        tokens.push({ type: 'lparen', text: ch, pos: i })
        i++
        continue
      }
      if (ch === ')') {
        tokens.push({ type: 'rparen', text: ch, pos: i })
        i++
        continue
      }
      if (ch === ',') {
        tokens.push({ type: 'comma', text: ch, pos: i })
        i++
        continue
      }
      tokens.push({ type: 'op', text: ch, pos: i })
      i++
      continue
    }

    throw new FormulaError(`Unexpected character '${ch}'`, i)
  }

  tokens.push({ type: 'eof', text: '', pos: input.length })
  return tokens
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Node =
  | { type: 'literal'; value: Value }
  | { type: 'column'; name: string }
  | { type: 'unary'; op: string; operand: Node }
  | { type: 'binary'; op: string; left: Node; right: Node }
  | { type: 'call'; name: string; args: Node[] }

// Recursive-descent parser with conventional precedence:
// comparison < additive < multiplicative < unary < power < primary
class Parser {
  private i = 0
  private readonly tokens: Token[]
  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token {
    return this.tokens[this.i]
  }

  private next(): Token {
    return this.tokens[this.i++]
  }

  private expect(type: TokenType): Token {
    const t = this.tokens[this.i]
    if (t.type !== type) throw new FormulaError(`Expected '${type}' but got '${t.text || 'end'}'`, t.pos)
    this.i++
    return t
  }

  parse(): Node {
    const node = this.parseComparison()
    if (this.peek().type !== 'eof') {
      throw new FormulaError(`Unexpected token '${this.peek().text}'`, this.peek().pos)
    }
    return node
  }

  private parseComparison(): Node {
    let node = this.parseAdditive()
    while (this.peek().type === 'op' && ['=', '==', '!=', '<', '<=', '>', '>='].includes(this.peek().text)) {
      const op = this.next().text
      node = { type: 'binary', op, left: node, right: this.parseAdditive() }
    }
    return node
  }

  private parseAdditive(): Node {
    let node = this.parseMultiplicative()
    while (this.peek().type === 'op' && (this.peek().text === '+' || this.peek().text === '-' || this.peek().text === '&')) {
      const op = this.next().text
      node = { type: 'binary', op, left: node, right: this.parseMultiplicative() }
    }
    return node
  }

  private parseMultiplicative(): Node {
    let node = this.parseUnary()
    while (this.peek().type === 'op' && (this.peek().text === '*' || this.peek().text === '/' || this.peek().text === '%')) {
      const op = this.next().text
      node = { type: 'binary', op, left: node, right: this.parseUnary() }
    }
    return node
  }

  private parseUnary(): Node {
    const t = this.peek()
    if (t.type === 'op' && (t.text === '-' || t.text === '+')) {
      this.next()
      return { type: 'unary', op: t.text, operand: this.parseUnary() }
    }
    return this.parsePower()
  }

  private parsePower(): Node {
    const node = this.parsePrimary()
    if (this.peek().type === 'op' && this.peek().text === '^') {
      this.next()
      return { type: 'binary', op: '^', left: node, right: this.parseUnary() } // right-associative
    }
    return node
  }

  private parsePrimary(): Node {
    const t = this.next()
    switch (t.type) {
      case 'number':
        return { type: 'literal', value: t.value ?? 0 }
      case 'string':
        return { type: 'literal', value: t.text }
      case 'column':
        return { type: 'column', name: t.text }
      case 'lparen': {
        const node = this.parseComparison()
        this.expect('rparen')
        return node
      }
      case 'ident': {
        const name = t.text
        if (this.peek().type !== 'lparen') {
          throw new FormulaError(`Unknown name '${name}' — wrap a column as {${name}}`, t.pos)
        }
        this.next()
        const args: Node[] = []
        if (this.peek().type !== 'rparen') {
          args.push(this.parseComparison())
          while (this.peek().type === 'comma') {
            this.next()
            args.push(this.parseComparison())
          }
        }
        this.expect('rparen')
        return { type: 'call', name: name.toUpperCase(), args }
      }
      default:
        throw new FormulaError('Unexpected token', t.pos)
    }
  }
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function toNumber(v: Value): number {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = Number(v.trim().replace(/,/g, ''))
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function toText(v: Value): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return String(v)
}

function truthy(v: Value): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return v !== ''
}

function looseEquals(a: Value, b: Value): boolean {
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  if (typeof a === 'number' || typeof b === 'number') return toNumber(a) === toNumber(b)
  return toText(a) === toText(b)
}

// ---------------------------------------------------------------------------
// Scalar function library (per-row only — no aggregates)
// ---------------------------------------------------------------------------

const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
  ABS: ([x]) => Math.abs(toNumber(x)),
  ROUND: ([x, d]) => {
    const places = Math.max(0, Math.round(toNumber(d ?? 0)))
    const factor = 10 ** places
    return Math.round(toNumber(x) * factor) / factor
  },
  CEIL: ([x]) => Math.ceil(toNumber(x)),
  FLOOR: ([x]) => Math.floor(toNumber(x)),
  SQRT: ([x]) => Math.sqrt(toNumber(x)),
  LEN: ([s]) => toText(s).length,
  UPPER: ([s]) => toText(s).toUpperCase(),
  LOWER: ([s]) => toText(s).toLowerCase(),
  TRIM: ([s]) => toText(s).trim(),
  IF: ([cond, t, f]) => (truthy(cond ?? false) ? t ?? '' : f ?? ''),
  COALESCE: (args) => args.find((a) => a !== null && a !== undefined) ?? (args.length ? args[args.length - 1] : null),
  // Capture group `group` (default 0 = the whole match) of the first regex
  // match in `text`, or '' when nothing matches — so the result can drive IF()
  // directly ('' is falsy). `flags` is an optional JS flag string, e.g. 'i'.
  //   REGEXEXTRACT({NAME}, '(\d{8}[A-Za-z]{2})', 1, 'i')
  REGEXEXTRACT: ([text, pattern, group, flags]) => {
    const source = toText(text)
    const expr = toText(pattern)
    if (!source || !expr) return ''
    let re: RegExp
    try {
      re = new RegExp(expr, toText(flags))
    } catch (err) {
      throw new FormulaError(
        `Invalid regular expression '${expr}': ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    }
    const match = re.exec(source)
    if (!match) return ''
    // A group beyond the pattern's capture groups yields undefined → ''.
    const index = group === undefined || group === null ? 0 : Math.max(0, Math.trunc(toNumber(group)))
    return match[index] ?? ''
  },
  // CIELAB → sRGB → '#rrggbb' (D65 white point, sRGB transfer function). Ported
  // from backend/templates/color-conversions-pantone-tcx.js (labToHex) so the
  // ColorDB colour measurements can carry a readable swatch value.
  //   LABTOHEX({L}, {a}, {b})
  LABTOHEX: ([l, a, b]) => {
    // A blank measurement stays blank instead of collapsing to black.
    const isBlank = (v: Value) => v === null || v === undefined || v === ''
    if (isBlank(l) || isBlank(a) || isBlank(b)) return ''
    const L = toNumber(l)
    const A = toNumber(a)
    const B = toNumber(b)
    // LAB → XYZ
    const py = (L + 16) / 116
    const inversePivot = (v: number) => (v ** 3 > 0.008856 ? v ** 3 : (v - 16 / 116) / 7.787)
    const X = 95.047 * inversePivot(A / 500 + py)
    const Y = 100.0 * inversePivot(py)
    const Z = 108.883 * inversePivot(py - B / 200)
    // XYZ → linear sRGB → gamma-encoded 0-255
    const x = X / 100
    const y = Y / 100
    const z = Z / 100
    const gamma = (v: number) => (v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v)
    const channel = (v: number) => Math.min(255, Math.max(0, Math.round(255 * gamma(v))))
    const r = channel(3.2406 * x - 1.5372 * y - 0.4986 * z)
    const g = channel(-0.9689 * x + 1.8758 * y + 0.0415 * z)
    const blue = channel(0.0557 * x - 0.204 * y + 1.057 * z)
    const hex = (v: number) => v.toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(blue)}`
  },
}

function applyFunction(name: string, args: Value[]): Value {
  const fn = FUNCTIONS[name]
  if (!fn) throw new FormulaError(`Unknown function '${name}'`)
  return fn(args)
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function evalNode(node: Node, row: Record<string, unknown>): Value {
  switch (node.type) {
    case 'literal':
      return node.value
    case 'column': {
      const raw = row[node.name]
      return raw === undefined || raw === null ? null : (raw as Value)
    }
    case 'unary': {
      const v = evalNode(node.operand, row)
      return node.op === '-' ? -toNumber(v) : toNumber(v)
    }
    case 'binary': {
      const left = evalNode(node.left, row)
      const right = evalNode(node.right, row)
      switch (node.op) {
        case '+':
          return typeof left === 'string' || typeof right === 'string'
            ? toText(left) + toText(right)
            : toNumber(left) + toNumber(right)
        case '-':
          return toNumber(left) - toNumber(right)
        case '*':
          return toNumber(left) * toNumber(right)
        case '/':
          return toNumber(left) / toNumber(right)
        case '%':
          return toNumber(left) % toNumber(right)
        case '^':
          return toNumber(left) ** toNumber(right)
        case '&':
          return toText(left) + toText(right)
        case '=':
        case '==':
          return looseEquals(left, right)
        case '!=':
          return !looseEquals(left, right)
        case '<':
          return toNumber(left) < toNumber(right)
        case '<=':
          return toNumber(left) <= toNumber(right)
        case '>':
          return toNumber(left) > toNumber(right)
        case '>=':
          return toNumber(left) >= toNumber(right)
        default:
          throw new FormulaError(`Unknown operator '${node.op}'`)
      }
    }
    case 'call':
      return applyFunction(node.name, node.args.map((a) => evalNode(a, row)))
    default:
      throw new FormulaError('Unexpected expression')
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Evaluate a formula against a single row. Throws FormulaError on bad syntax. */
export function evaluateFormula(expression: string, row: Record<string, unknown>): Value {
  const node = new Parser(tokenize(expression)).parse()
  return evalNode(node, row)
}

/** Return a human-readable error message, or null when the formula is valid. */
export function validateFormula(expression: string): string | null {
  if (!expression.trim()) return 'Enter a formula.'
  try {
    evaluateFormula(expression, {})
    return null
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid formula'
  }
}

/** Preview the first `limit` computed values (throwing on syntax errors). */
export function previewFormula(
  expression: string,
  rows: Record<string, unknown>[],
  limit = 8,
): Value[] {
  const node = new Parser(tokenize(expression)).parse()
  return rows.slice(0, limit).map((row) => evalNode(node, row))
}

/** Column names referenced by a formula (used to surface typos in the helper). */
export function extractColumnRefs(expression: string): string[] {
  try {
    return tokenize(expression)
      .filter((t) => t.type === 'column')
      .map((t) => t.text)
  } catch {
    return []
  }
}
