// A JSON reader that answers with an error instead of trapping, and the
// escaping half that writes a verdict back out.
//
// ## Why this file exists rather than a dependency
//
// `assemblyscript-json@1.1.0` is the package an author would reach for, and it
// was measured against this compiler before this file was written: it compiles
// under assemblyscript 0.28.20, reads the real evidence fixtures in
// `../fixtures/`, and handles nested objects, arrays, `null`, escapes and
// non-ASCII text correctly. It is not broken. What decided against it is a
// single structural fact — its decoder reports every malformed document
// through `assert()`, which under the zero-import build (`../README.md`) is an
// `unreachable` instruction. Measured: `not json at all`, a truncated object,
// an empty document and an unknown escape each reach the host as
// `archkeep_evaluate trapped (unreachable)`.
//
// A trap is loud, and the host names it — so nothing silent was at stake. What
// was at stake is WHICH fault the reader is told about: the Rust SDK answers
// an unreadable bundle with `unknown` naming the bundle
// (`../../archkeep-rule-sdk-rust/src/abi.rs`), and a conformance suite that
// four SDKs must reproduce cannot have one of them answering "the module
// trapped" where the others answer "the evidence bundle could not be read".
// Two further facts, neither decisive alone: the package was last published in
// April 2022 against `assemblyscript ^0.19.5` and would be compiled INTO every
// artifact a workspace pins by sha256, and it carries no nesting bound —
// measured, a 500-deep array parsed without complaint, where the reader below
// stops at `MAX_DEPTH` and says so.
//
// Size was not a reason either way: the two spikes came out at 16,161 and
// 15,781 bytes for the same work.
//
// ## What it is NOT
//
// It is not a general-purpose JSON library and does not try to be. It reads
// exactly what the engine's canonical serializer writes
// (`../../archkeep/src/canonical.mjs`) plus whatever a policy row's `params`
// happens to hold, and every value it cannot read becomes a named error the
// caller turns into an `unknown` verdict. Numbers arrive as `f64`, which is
// what JSON numbers are; the evidence contract's only numeric fields are
// 1-based line and column positions, far inside the exactly-representable
// range.

/** What a parsed value is. */
export const enum JsonKind {
  /** `null`. */
  Null = 0,
  /** `true` or `false`. */
  Bool = 1,
  /** A JSON number, held as `f64`. */
  Number = 2,
  /** A JSON string, unescaped. */
  String = 3,
  /** An array. */
  Array = 4,
  /** An object. */
  Object = 5,
}

/**
 * One parsed JSON value.
 *
 * One class for all six kinds rather than a hierarchy: AssemblyScript has no
 * closures over generic sum types, and a rule reading `params` asks "is this a
 * string?" far more often than it dispatches on a kind. Object members are kept
 * as parallel `keys`/`values` arrays rather than a `Map`, which keeps the
 * written order — the order a rule sees is the order the workspace wrote — and
 * costs a linear scan over objects that carry at most a dozen keys.
 */
export class JsonValue {
  /** Which of the six kinds this is. */
  kind: JsonKind = JsonKind.Null;
  /** The value, when `kind` is `Bool`. */
  bool: bool = false;
  /** The value, when `kind` is `Number`. */
  num: f64 = 0;
  /** The value, unescaped, when `kind` is `String`. */
  str: string = "";
  /** The elements, when `kind` is `Array`. */
  items: JsonValue[] = [];
  /** The member names, in written order, when `kind` is `Object`. */
  keys: string[] = [];
  /** The member values, parallel to `keys`. */
  values: JsonValue[] = [];

  /** Whether this value is `null`. Distinct from an absent member. */
  get isNull(): bool {
    return this.kind == JsonKind.Null;
  }

  /** Whether this value is an object. */
  get isObject(): bool {
    return this.kind == JsonKind.Object;
  }

  /** Whether this value is an array. */
  get isArray(): bool {
    return this.kind == JsonKind.Array;
  }

  /** Whether this value is a string. */
  get isString(): bool {
    return this.kind == JsonKind.String;
  }

  /** Whether this value is a number. */
  get isNumber(): bool {
    return this.kind == JsonKind.Number;
  }

  /**
   * The member of this name, or `null` when this value is not an object or
   * states no such member.
   *
   * A present member holding JSON `null` answers with a `JsonValue` whose
   * `isNull` is true, which is a different answer from this one — the evidence
   * contract uses both (`imports[].resolved` is `null` for an unresolvable
   * import site and absent from nothing), so collapsing them would lose the
   * distinction a rule has to read.
   */
  get(key: string): JsonValue | null {
    for (let index = 0, count = this.keys.length; index < count; index++) {
      if (this.keys[index] == key) return this.values[index];
    }
    return null;
  }

  /** The member of this name when it is a string, `null` otherwise. */
  getString(key: string): string | null {
    const value = this.get(key);
    if (value == null) return null;
    return value.kind == JsonKind.String ? value.str : null;
  }

  /** The member of this name when it is an array, `null` otherwise. */
  getArray(key: string): JsonValue[] | null {
    const value = this.get(key);
    if (value == null) return null;
    return value.kind == JsonKind.Array ? value.items : null;
  }

  /** The member of this name when it is an object, `null` otherwise. */
  getObject(key: string): JsonValue | null {
    const value = this.get(key);
    if (value == null) return null;
    return value.kind == JsonKind.Object ? value : null;
  }
}

/**
 * What `JsonReader.parse` answers with.
 *
 * `value` and `error` rather than a tagged union, for the reason the whole file
 * exists: the caller must be unable to read a failure as an empty document.
 * `value` is `null` exactly when `error` is non-empty.
 */
export class JsonResult {
  /** The parsed document, or `null` when the text could not be read. */
  value: JsonValue | null = null;
  /** What was wrong, named. Empty exactly when `value` is present. */
  error: string = "";
}

/**
 * How deep a document may nest before the reader refuses it.
 *
 * The reader is recursive, and a wasm module's stack is not something it can
 * measure — a document deep enough to exhaust it would trap somewhere inside
 * the descent, and the host would report that the rule trapped. Sixty-four is
 * far past the evidence contract's own shape (five levels at its deepest) and
 * far short of any stack this compiles to, so the bound is reached as a named
 * error rather than as a stack that ran out.
 */
const MAX_DEPTH: i32 = 64;

/** Character codes the scanner compares against, named where they are used. */
const CH_TAB: i32 = 0x09;
const CH_NEWLINE: i32 = 0x0a;
const CH_RETURN: i32 = 0x0d;
const CH_SPACE: i32 = 0x20;
const CH_QUOTE: i32 = 0x22;
const CH_PLUS: i32 = 0x2b;
const CH_COMMA: i32 = 0x2c;
const CH_MINUS: i32 = 0x2d;
const CH_DOT: i32 = 0x2e;
const CH_SLASH: i32 = 0x2f;
const CH_ZERO: i32 = 0x30;
const CH_NINE: i32 = 0x39;
const CH_COLON: i32 = 0x3a;
const CH_UPPER_A: i32 = 0x41;
const CH_UPPER_E: i32 = 0x45;
const CH_UPPER_F: i32 = 0x46;
const CH_BRACKET_OPEN: i32 = 0x5b;
const CH_BACKSLASH: i32 = 0x5c;
const CH_BRACKET_CLOSE: i32 = 0x5d;
const CH_LOWER_A: i32 = 0x61;
const CH_LOWER_B: i32 = 0x62;
const CH_LOWER_E: i32 = 0x65;
const CH_LOWER_F: i32 = 0x66;
const CH_LOWER_N: i32 = 0x6e;
const CH_LOWER_R: i32 = 0x72;
const CH_LOWER_T: i32 = 0x74;
const CH_LOWER_U: i32 = 0x75;
const CH_BRACE_OPEN: i32 = 0x7b;
const CH_BRACE_CLOSE: i32 = 0x7d;

/**
 * A recursive-descent reader over one UTF-16 string.
 *
 * The text is a `string` rather than the raw bytes because
 * `String.UTF8.decodeUnsafe` has already done the decoding by the time a rule
 * is called, and every character JSON's own grammar cares about is ASCII —
 * everything else is string content that passes through untouched.
 */
export class JsonReader {
  private text: string;
  private at: i32 = 0;
  private len: i32;
  /** What went wrong, set once and never overwritten by a later failure. */
  error: string = "";

  constructor(text: string) {
    this.text = text;
    this.len = text.length;
  }

  /**
   * Reads one whole JSON document.
   *
   * Trailing text is refused rather than ignored: bytes after the document are
   * bytes nobody wrote on purpose, and reading the prefix would be a rule
   * judging half a bundle.
   */
  static parse(text: string): JsonResult {
    const reader = new JsonReader(text);
    const result = new JsonResult();
    const value = reader.readValue(0);
    if (value == null) {
      result.error = reader.error;
      return result;
    }
    reader.skipSpace();
    if (reader.at != reader.len) {
      result.error =
        "there is text after the end of the document, at offset " + reader.at.toString();
      return result;
    }
    result.value = value;
    return result;
  }

  private fail(detail: string): JsonValue | null {
    this.record(detail);
    return null;
  }

  private record(detail: string): void {
    // First failure wins: the innermost one names the actual fault, and a
    // caller unwinding through three levels would otherwise be told about the
    // outermost bracket rather than the character that broke.
    if (this.error.length == 0) this.error = detail + ", at offset " + this.at.toString();
  }

  private skipSpace(): void {
    while (this.at < this.len) {
      const code = this.text.charCodeAt(this.at);
      if (code == CH_SPACE || code == CH_TAB || code == CH_NEWLINE || code == CH_RETURN) {
        this.at++;
      } else {
        break;
      }
    }
  }

  private readValue(depth: i32): JsonValue | null {
    if (depth > MAX_DEPTH) {
      return this.fail("the document nests deeper than " + MAX_DEPTH.toString() + " levels");
    }
    this.skipSpace();
    if (this.at >= this.len) return this.fail("the document ends where a value was expected");
    const code = this.text.charCodeAt(this.at);
    if (code == CH_BRACE_OPEN) return this.readObject(depth);
    if (code == CH_BRACKET_OPEN) return this.readArray(depth);
    if (code == CH_QUOTE) return this.readString();
    if (code == CH_LOWER_T) return this.readWord("true");
    if (code == CH_LOWER_F) return this.readWord("false");
    if (code == CH_LOWER_N) return this.readWord("null");
    return this.readNumber();
  }

  private readWord(word: string): JsonValue | null {
    for (let index = 0; index < word.length; index++) {
      const here = this.at + index;
      if (here >= this.len || this.text.charCodeAt(here) != word.charCodeAt(index)) {
        return this.fail("a value begins like " + word + " and is not " + word);
      }
    }
    this.at += word.length;
    const value = new JsonValue();
    if (word == "null") {
      value.kind = JsonKind.Null;
    } else {
      value.kind = JsonKind.Bool;
      value.bool = word == "true";
    }
    return value;
  }

  private readNumber(): JsonValue | null {
    const start = this.at;
    if (this.at < this.len && this.text.charCodeAt(this.at) == CH_MINUS) this.at++;
    let digits = 0;
    while (this.at < this.len) {
      const code = this.text.charCodeAt(this.at);
      if (code >= CH_ZERO && code <= CH_NINE) {
        this.at++;
        digits++;
      } else if (
        code == CH_DOT ||
        code == CH_LOWER_E ||
        code == CH_UPPER_E ||
        code == CH_PLUS ||
        code == CH_MINUS
      ) {
        this.at++;
      } else {
        break;
      }
    }
    if (digits == 0) return this.fail("a value that is none of the six JSON kinds");
    const value = new JsonValue();
    value.kind = JsonKind.Number;
    value.num = parseFloat(this.text.slice(start, this.at));
    return value;
  }

  private readString(): JsonValue | null {
    const text = this.readQuoted();
    if (text == null) return null;
    const value = new JsonValue();
    value.kind = JsonKind.String;
    value.str = text;
    return value;
  }

  /**
   * One quoted string, unescaped.
   *
   * Answers the string itself rather than a `JsonValue`, because an object's
   * member NAME is a quoted string that never becomes a value.
   */
  private readQuoted(): string | null {
    if (this.at >= this.len || this.text.charCodeAt(this.at) != CH_QUOTE) {
      this.record("a string was expected");
      return null;
    }
    this.at++;
    let out = "";
    let chunk = this.at;
    while (this.at < this.len) {
      const code = this.text.charCodeAt(this.at);
      if (code == CH_QUOTE) {
        out += this.text.slice(chunk, this.at);
        this.at++;
        return out;
      }
      if (code != CH_BACKSLASH) {
        this.at++;
        continue;
      }
      out += this.text.slice(chunk, this.at);
      this.at++;
      if (this.at >= this.len) {
        this.record("the document ends inside a string escape");
        return null;
      }
      const escape = this.text.charCodeAt(this.at);
      this.at++;
      if (escape == CH_QUOTE) out += '"';
      else if (escape == CH_BACKSLASH) out += "\\";
      else if (escape == CH_SLASH) out += "/";
      else if (escape == CH_LOWER_B) out += String.fromCharCode(0x08);
      else if (escape == CH_LOWER_F) out += String.fromCharCode(0x0c);
      else if (escape == CH_LOWER_N) out += "\n";
      else if (escape == CH_LOWER_R) out += "\r";
      else if (escape == CH_LOWER_T) out += "\t";
      else if (escape == CH_LOWER_U) {
        const unit = this.readHexQuad();
        if (unit < 0) return null;
        // A surrogate half is written through as itself: the pair the engine
        // wrote arrives as two escapes, and appending each half in turn
        // rebuilds the code point in a UTF-16 string.
        out += String.fromCharCode(unit);
      } else {
        this.record("a string carries an escape JSON does not define");
        return null;
      }
      chunk = this.at;
    }
    this.record("the document ends inside a string");
    return null;
  }

  /** The four hex digits of a `\u` escape, or `-1` having recorded why not. */
  private readHexQuad(): i32 {
    if (this.at + 4 > this.len) {
      this.record("the document ends inside a \\u escape");
      return -1;
    }
    let code = 0;
    for (let index = 0; index < 4; index++) {
      const digit = this.text.charCodeAt(this.at + index);
      let nibble = -1;
      if (digit >= CH_ZERO && digit <= CH_NINE) nibble = digit - CH_ZERO;
      else if (digit >= CH_LOWER_A && digit <= CH_LOWER_F) nibble = digit - CH_LOWER_A + 10;
      else if (digit >= CH_UPPER_A && digit <= CH_UPPER_F) nibble = digit - CH_UPPER_A + 10;
      if (nibble < 0) {
        this.record("a \\u escape carries a digit that is not hexadecimal");
        return -1;
      }
      code = code * 16 + nibble;
    }
    this.at += 4;
    return code;
  }

  private readArray(depth: i32): JsonValue | null {
    this.at++;
    const value = new JsonValue();
    value.kind = JsonKind.Array;
    this.skipSpace();
    if (this.at < this.len && this.text.charCodeAt(this.at) == CH_BRACKET_CLOSE) {
      this.at++;
      return value;
    }
    while (true) {
      const item = this.readValue(depth + 1);
      if (item == null) return null;
      value.items.push(item);
      this.skipSpace();
      if (this.at >= this.len) return this.fail("the document ends inside an array");
      const code = this.text.charCodeAt(this.at);
      if (code == CH_COMMA) {
        this.at++;
        continue;
      }
      if (code == CH_BRACKET_CLOSE) {
        this.at++;
        return value;
      }
      return this.fail("an array element is followed by neither ',' nor ']'");
    }
  }

  private readObject(depth: i32): JsonValue | null {
    this.at++;
    const value = new JsonValue();
    value.kind = JsonKind.Object;
    this.skipSpace();
    if (this.at < this.len && this.text.charCodeAt(this.at) == CH_BRACE_CLOSE) {
      this.at++;
      return value;
    }
    while (true) {
      this.skipSpace();
      const key = this.readQuoted();
      if (key == null) return null;
      this.skipSpace();
      if (this.at >= this.len || this.text.charCodeAt(this.at) != CH_COLON) {
        return this.fail("an object member name is not followed by ':'");
      }
      this.at++;
      const member = this.readValue(depth + 1);
      if (member == null) return null;
      value.keys.push(key);
      value.values.push(member);
      this.skipSpace();
      if (this.at >= this.len) return this.fail("the document ends inside an object");
      const code = this.text.charCodeAt(this.at);
      if (code == CH_COMMA) {
        this.at++;
        continue;
      }
      if (code == CH_BRACE_CLOSE) {
        this.at++;
        return value;
      }
      return this.fail("an object member is followed by neither ',' nor '}'");
    }
  }
}

/**
 * `text` as a JSON string literal, quotes included.
 *
 * Every control character below 0x20 is escaped, because a raw one inside a
 * string is not JSON and the host would refuse the verdict as unparseable —
 * which is a real risk here rather than a theoretical one: a finding's message
 * carries a specifier and a file path a rule read out of the evidence, and a
 * workspace's own text is not this SDK's to trust.
 */
export function quoteJsonString(text: string): string {
  let out = '"';
  for (let index = 0, count = text.length; index < count; index++) {
    const code = text.charCodeAt(index);
    if (code == CH_QUOTE) out += '\\"';
    else if (code == CH_BACKSLASH) out += "\\\\";
    else if (code == CH_NEWLINE) out += "\\n";
    else if (code == CH_RETURN) out += "\\r";
    else if (code == CH_TAB) out += "\\t";
    else if (code == 0x08) out += "\\b";
    else if (code == 0x0c) out += "\\f";
    else if (code < CH_SPACE) out += "\\u" + hex4(code);
    else out += String.fromCharCode(code);
  }
  return out + '"';
}

/** One UTF-16 code unit as exactly four lowercase hex digits. */
function hex4(code: i32): string {
  const digits = "0123456789abcdef";
  let out = "";
  for (let shift = 12; shift >= 0; shift -= 4) {
    const nibble = (code >> shift) & 0xf;
    out += digits.charAt(nibble);
  }
  return out;
}
