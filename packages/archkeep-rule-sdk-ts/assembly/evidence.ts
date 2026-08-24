// The evidence bundle, typed.
//
// Every field name and every optionality below is read off the engine's own
// assembly (`../../archkeep/src/custom-rules/evidence.mjs`) and the frozen record
// it copies through (`../../archkeep/src/analysis/contract.md`). The bundle is
// the wire, not the engine's internals: `../../archkeep/src/config.mjs` calls the
// eight boundary settings `options` and the bundle renames them to
// `moduleBoundaryOptions` — the name the workspace itself wrote — so that is the
// name here too.
//
// ## Unknown fields are accepted, unknown VALUES are not
//
// Nothing here refuses a member it does not read. The evidence contract "grows
// additively within a version"
// (`../../../docs/adr/0002-custom-rules-one-contract.md`, Consequences), so a
// rule compiled today must keep reading a bundle that gained a field tomorrow —
// refusing it would make every existing rule `unknown` on an engine upgrade that
// added nothing they read.
//
// An unknown VALUE is the opposite case. `ImportKind` is closed because
// `../../archkeep/src/analysis/contract.md` fixes those four kinds, and a fifth
// one arriving is a contract change a rule must be rebuilt for. Reading it as
// "some other kind" would let a rule judge a record it had misread; the named
// error it produces instead becomes an `unknown` verdict (`./abi.ts`), which is
// the loud direction.
//
// ## Every read is a checked read, and a failure names the path
//
// AssemblyScript has no exception a caller can catch — a `throw` compiles to
// the `abort` the zero-import build turns into a trap — so there is no
// serde-shaped "deserialize or error" to lean on. What replaces it is a
// `Reading`: one error slot threaded through the descent, set by the first
// member that is missing or the wrong kind, naming the path it was reading
// (`imports[3].spelling.relative`). A caller sees a `null` bundle and a
// sentence, and turns it into `unknown` — never into an empty model it could
// judge over.

import { JsonKind, JsonReader, JsonValue } from "./json";
import { CONTRACT } from "./declaration";
import { Finding } from "./verdict";

/**
 * The error slot one bundle read shares.
 *
 * A field rather than a return value on every function, because AssemblyScript
 * has no generic `Result<T, E>` this code could return without boxing every
 * scalar it reads.
 */
class Reading {
  /** What was wrong, named with the path. Empty while nothing has failed. */
  error: string = "";

  /** Records the first failure and answers `false`, for a caller to return. */
  fail(path: string, detail: string): bool {
    if (this.error.length == 0) this.error = path + " " + detail;
    return false;
  }

  /** Whether anything has failed. */
  get failed(): bool {
    return this.error.length > 0;
  }
}

/** The member of `owner` at `key` when it is a string, recording why not. */
function readString(reading: Reading, owner: JsonValue, key: string, path: string): string {
  const value = owner.get(key);
  if (value == null) {
    reading.fail(path, "is absent, and contract " + CONTRACT.toString() + " states it");
    return "";
  }
  if (!value.isString) {
    reading.fail(path, "is not a string");
    return "";
  }
  return value.str;
}

/** The member at `key` when it is a string or JSON `null`; `null` for both absent and null. */
function readNullableString(
  reading: Reading,
  owner: JsonValue,
  key: string,
  path: string,
): string | null {
  const value = owner.get(key);
  if (value == null) {
    reading.fail(path, "is absent, and contract " + CONTRACT.toString() + " states it");
    return null;
  }
  if (value.isNull) return null;
  if (!value.isString) {
    reading.fail(path, "is neither a string nor null");
    return null;
  }
  return value.str;
}

/** The member at `key` when it is a boolean, recording why not. */
function readBool(reading: Reading, owner: JsonValue, key: string, path: string): bool {
  const value = owner.get(key);
  if (value == null) {
    reading.fail(path, "is absent, and contract " + CONTRACT.toString() + " states it");
    return false;
  }
  if (value.kind != JsonKind.Bool) {
    reading.fail(path, "is not a boolean");
    return false;
  }
  return value.bool;
}

/** The member at `key` when it is a number, as the 32-bit integer the contract fixes. */
function readInt(reading: Reading, owner: JsonValue, key: string, path: string): i32 {
  const value = owner.get(key);
  if (value == null) {
    reading.fail(path, "is absent, and contract " + CONTRACT.toString() + " states it");
    return 0;
  }
  if (!value.isNumber) {
    reading.fail(path, "is not a number");
    return 0;
  }
  return <i32>value.num;
}

/** The member at `key` when it is an object, recording why not. */
function readObject(reading: Reading, owner: JsonValue, key: string, path: string): JsonValue {
  const value = owner.getObject(key);
  if (value == null) {
    reading.fail(path, "is not the object contract " + CONTRACT.toString() + " states");
    return new JsonValue();
  }
  return value;
}

/** The member at `key` when it is an array, recording why not. */
function readArray(reading: Reading, owner: JsonValue, key: string, path: string): JsonValue[] {
  const value = owner.getArray(key);
  if (value == null) {
    reading.fail(path, "is not the array contract " + CONTRACT.toString() + " states");
    return [];
  }
  return value;
}

/** One project, as the workspace's provider reported it. */
export class Project {
  /** The project's name — the identity every edge and every attribution uses. */
  name: string = "";
  /** The project's root, workspace-relative. */
  root: string = "";
  /**
   * The project's tags, verbatim. An untagged project carries `[]`; the engine
   * refuses to build a bundle in which "no tags" and "tags were never read" look
   * the same, so an empty list here is a fact.
   */
  tags: string[] = [];

  /**
   * Whether this project carries `tag`, compared exactly.
   *
   * Exact rather than prefix- or glob-matched on purpose: a tag vocabulary
   * belongs to the workspace, and a rule that matched `layer-` loosely would be
   * inventing a grammar the workspace never agreed to.
   */
  hasTag(tag: string): bool {
    for (let index = 0; index < this.tags.length; index++) {
      if (this.tags[index] == tag) return true;
    }
    return false;
  }
}

/** One dependency edge. */
export class Edge {
  /** The depending project's name. */
  source: string = "";
  /** The depended-on project's name. */
  target: string = "";
  /**
   * How the dependency was established — `"static"`, and whatever else the
   * workspace's own provider emits.
   *
   * A string rather than a closed set, because this vocabulary is the graph
   * provider's (Nx's, Moon's, or the native model's) and not something contract
   * 1 fixes. Closing it would refuse a workspace whose provider spells a type
   * this package had never heard of, which is a rule failing on a fact it did
   * not need.
   */
  edgeType: string = "";
  /**
   * The file the dependency was read from, when the provider carried one.
   * Absent is normal: `nx graph --file=` emits no `sourceFile` on any edge.
   */
  sourceFile: string | null = null;
}

/** How an import was written — the four forms the analysis contract fixes. */
export const enum ImportKind {
  /** A top-level `import`/`require`/`use`/Go import declaration. */
  Static = 0,
  /** `import()` and its per-language equivalents. */
  Dynamic = 1,
  /** Erased before runtime (`import type`), so it creates no runtime dependency. */
  TypeOnly = 2,
  /** `export … from` — an import and a re-publish in one statement. */
  ReExport = 3,
}

/** How a specifier is spelled, in the language it was written in. */
export class Spelling {
  /**
   * The specifier is a filesystem path, resolvable by path arithmetic against
   * the importing file, and names no package.
   */
  path: bool = false;
  /**
   * The specifier reaches inside its own project without going out through the
   * project's public name.
   */
  relative: bool = false;
}

/** Where a specifier points, when the analyzer could say. */
export class Resolved {
  /** The project it resolves into, or `null` when it resolves outside every project. */
  target: string | null = null;
  /** The workspace-relative file, or `null` when resolution stops at a package. */
  file: string | null = null;
  /** `true` when the specifier resolves outside every project. */
  external: bool = false;
  /**
   * The package's own name when external — `@scope/name`, not the deep path,
   * which is what a `bannedExternalImports` glob is matched against.
   */
  packageName: string | null = null;
}

/**
 * One import site: one written import, not one resolved dependency. A file
 * importing the same project three times yields three of these.
 */
export class ImportRecord {
  /**
   * The project owning the importing file. Added by the engine from the
   * workspace's files-per-project map — the only layer allowed to answer which
   * project owns which file — never re-derived from a root prefix.
   */
  sourceProject: string = "";
  /** The importing file, workspace-relative. */
  sourceFile: string = "";
  /** 1-based line of the import site. */
  line: i32 = 0;
  /** 1-based column of the import site. */
  column: i32 = 0;
  /**
   * The raw specifier, exactly as written. Five of the fifteen upstream boundary
   * violations are decided on this text rather than on the project pair it
   * resolves to, which is why the record keeps it.
   */
  specifier: string = "";
  /** The form the import takes. */
  kind: ImportKind = ImportKind.Static;
  /** How the specifier is spelled. */
  spelling: Spelling = new Spelling();
  /**
   * Where it points, or `null` when the analyzer could not say. `null` is a
   * recorded blind spot, never a dropped record and never a guess.
   */
  resolved: Resolved | null = null;

  /**
   * `finding`, placed at this site.
   *
   * Rust's `ImportRecord::position` answers an `Option<(NonZeroU32,
   * NonZeroU32)>` and leaves the placing to the caller; AssemblyScript has
   * neither tuples nor a non-zero integer type, so the pair is handed over by
   * doing the placing here. The behaviour is the same one, and it is the reason
   * this method exists rather than two public coordinates: a bundle carrying a
   * zero — which the engine never emits, every position it reports being 1-based
   * — places the finding in the FILE rather than at a line no file has.
   */
  place(finding: Finding): Finding {
    if (this.line < 1 || this.column < 1) return finding.inFile(this.sourceFile);
    return finding.at(this.sourceFile, this.line, this.column);
  }
}

/** The declared rule row, as the bundle carries it. */
export class RuleInstance {
  /**
   * The name the policy row declared, which is also the name this artifact's own
   * declaration must state.
   */
  name: string = "";
  /**
   * The row's `params`, verbatim. `{}` when the row declared none — the engine
   * writes that default into the BUNDLE and never back onto the policy, so a
   * rule reading an empty object cannot tell whether the workspace wrote
   * `params: {}` or omitted the field, and must not need to.
   */
  params: JsonValue = new JsonValue();
}

/** The `model` kind: every project the run covers, sorted by name. */
export class Model {
  /** The projects, in name order. */
  projects: Project[] = [];
}

/** The `graph` kind: every edge, sorted by source, target, type, then source file. */
export class Graph {
  /** The edges, in the order above. */
  edges: Edge[] = [];
}

/**
 * The `policy` kind: the two fields contract 1 carries of a loaded policy.
 *
 * Both stay raw JSON, and that is a decision rather than laziness. The
 * constraint row schema has exactly one owner
 * (`../../archkeep/src/config.mjs`, which validates it at load), and a second
 * model of it here would be a dialect: it would drift the first time a
 * governance key was added, and a rule reading through it would be judging a
 * policy the engine had already read differently.
 */
export class Policy {
  /**
   * The constraint rows, in the order the workspace wrote them — order is
   * semantic for a boundary policy, so the engine deliberately does not sort it.
   */
  depConstraints: JsonValue[] = [];
  /** The eight `@nx/enforce-module-boundaries` settings, as the workspace stated them. */
  moduleBoundaryOptions: JsonValue = new JsonValue();
}

/**
 * What `Evidence.read` answers with.
 *
 * `evidence` is `null` exactly when `error` is non-empty, and a caller that read
 * the one without the other would be reading a bundle that was never there.
 */
export class EvidenceResult {
  /** The bundle, or `null` when the bytes could not be read as one. */
  evidence: Evidence | null = null;
  /** What was wrong, named. Empty exactly when `evidence` is present. */
  error: string = "";
}

/** Everything a rule is handed, and the only thing it is ever handed. */
export class Evidence {
  /**
   * The contract version the bundle states. Always `CONTRACT` by the time a rule
   * sees it — `Evidence.read` refuses anything else rather than reading a
   * document it was not built against.
   */
  contract: i32 = 0;
  /** Which rule this bundle was built for, and the parameters its row declared. */
  rule: RuleInstance = new RuleInstance();
  /** The project model. */
  model: Model = new Model();
  /** The dependency graph. */
  graph: Graph = new Graph();
  /**
   * Every import site the analyzers read, each attributed to the project that
   * owns the importing file. In source order, which is part of the analysis
   * contract rather than an accident — the engine deliberately does not sort it.
   */
  imports: ImportRecord[] = [];
  /** The loaded policy. */
  policy: Policy = new Policy();

  /**
   * The project of this name, or `null`.
   *
   * `null` is the case a rule has to answer for rather than skip: an edge naming
   * a project the model does not carry means the two halves of the evidence
   * disagree, and a rule that silently ignored the edge would be reporting a
   * clean workspace it never finished reading.
   */
  project(name: string): Project | null {
    for (let index = 0; index < this.model.projects.length; index++) {
      if (this.model.projects[index].name == name) return this.model.projects[index];
    }
    return null;
  }

  /**
   * Reads a bundle from the UTF-8 text the host wrote into linear memory.
   *
   * Neither failure is recoverable inside a rule, and neither may be read as
   * "nothing found": `./abi.ts` turns both into `unknown` naming the cause.
   */
  static read(text: string): EvidenceResult {
    const result = new EvidenceResult();
    const parsed = JsonReader.parse(text);
    const root = parsed.value;
    if (root == null) {
      result.error =
        "the evidence bundle is not the JSON document contract " +
        CONTRACT.toString() +
        " describes — " +
        parsed.error;
      return result;
    }
    if (!root.isObject) {
      result.error =
        "the evidence bundle is not an object, and contract " +
        CONTRACT.toString() +
        " describes one";
      return result;
    }

    const reading = new Reading();
    const stated = readInt(reading, root, "contract", "contract");
    if (!reading.failed && stated != CONTRACT) {
      result.error =
        "the evidence bundle states contract " +
        stated.toString() +
        " and this rule was built against contract " +
        CONTRACT.toString() +
        " — a rule built for another contract is not approximated";
      return result;
    }

    const evidence = new Evidence();
    evidence.contract = stated;
    evidence.rule = readRule(reading, root);
    evidence.model = readModel(reading, root);
    evidence.graph = readGraph(reading, root);
    evidence.imports = readImports(reading, root);
    evidence.policy = readPolicy(reading, root);

    if (reading.failed) {
      result.error =
        "the evidence bundle could not be read as contract " +
        CONTRACT.toString() +
        ": " +
        reading.error;
      return result;
    }
    result.evidence = evidence;
    return result;
  }
}

function readRule(reading: Reading, root: JsonValue): RuleInstance {
  const rule = new RuleInstance();
  const object = readObject(reading, root, "rule", "rule");
  if (reading.failed) return rule;
  rule.name = readString(reading, object, "name", "rule.name");
  const params = object.get("params");
  if (params == null) {
    reading.fail("rule.params", "is absent, and the engine writes {} for a row that declares none");
    return rule;
  }
  rule.params = params;
  return rule;
}

function readModel(reading: Reading, root: JsonValue): Model {
  const model = new Model();
  const object = readObject(reading, root, "model", "model");
  if (reading.failed) return model;
  const rows = readArray(reading, object, "projects", "model.projects");
  for (let index = 0; index < rows.length; index++) {
    const path = "model.projects[" + index.toString() + "]";
    const row = rows[index];
    if (!row.isObject) {
      reading.fail(path, "is not an object");
      return model;
    }
    const project = new Project();
    project.name = readString(reading, row, "name", path + ".name");
    project.root = readString(reading, row, "root", path + ".root");
    const tags = readArray(reading, row, "tags", path + ".tags");
    for (let tag = 0; tag < tags.length; tag++) {
      if (!tags[tag].isString) {
        reading.fail(path + ".tags[" + tag.toString() + "]", "is not a string");
        return model;
      }
      project.tags.push(tags[tag].str);
    }
    if (reading.failed) return model;
    model.projects.push(project);
  }
  return model;
}

function readGraph(reading: Reading, root: JsonValue): Graph {
  const graph = new Graph();
  const object = readObject(reading, root, "graph", "graph");
  if (reading.failed) return graph;
  const rows = readArray(reading, object, "edges", "graph.edges");
  for (let index = 0; index < rows.length; index++) {
    const path = "graph.edges[" + index.toString() + "]";
    const row = rows[index];
    if (!row.isObject) {
      reading.fail(path, "is not an object");
      return graph;
    }
    const edge = new Edge();
    edge.source = readString(reading, row, "source", path + ".source");
    edge.target = readString(reading, row, "target", path + ".target");
    edge.edgeType = readString(reading, row, "type", path + ".type");
    // The one member of the contract that is absent rather than null when the
    // provider carried none, which is why it is read without `readString`'s
    // absent-is-a-failure rule.
    const sourceFile = row.get("sourceFile");
    if (sourceFile != null && !sourceFile.isNull) {
      if (!sourceFile.isString) {
        reading.fail(path + ".sourceFile", "is neither a string nor absent");
        return graph;
      }
      edge.sourceFile = sourceFile.str;
    }
    if (reading.failed) return graph;
    graph.edges.push(edge);
  }
  return graph;
}

function readImports(reading: Reading, root: JsonValue): ImportRecord[] {
  const records: ImportRecord[] = [];
  const rows = readArray(reading, root, "imports", "imports");
  for (let index = 0; index < rows.length; index++) {
    const path = "imports[" + index.toString() + "]";
    const row = rows[index];
    if (!row.isObject) {
      reading.fail(path, "is not an object");
      return records;
    }
    const record = new ImportRecord();
    record.sourceProject = readString(reading, row, "sourceProject", path + ".sourceProject");
    record.sourceFile = readString(reading, row, "sourceFile", path + ".sourceFile");
    record.line = readInt(reading, row, "line", path + ".line");
    record.column = readInt(reading, row, "column", path + ".column");
    record.specifier = readString(reading, row, "specifier", path + ".specifier");
    record.kind = readImportKind(reading, row, path);
    record.spelling = readSpelling(reading, row, path);
    record.resolved = readResolved(reading, row, path);
    if (reading.failed) return records;
    records.push(record);
  }
  return records;
}

function readImportKind(reading: Reading, row: JsonValue, path: string): ImportKind {
  const spelled = readString(reading, row, "kind", path + ".kind");
  if (reading.failed) return ImportKind.Static;
  if (spelled == "static") return ImportKind.Static;
  if (spelled == "dynamic") return ImportKind.Dynamic;
  if (spelled == "type-only") return ImportKind.TypeOnly;
  if (spelled == "re-export") return ImportKind.ReExport;
  reading.fail(
    path + ".kind",
    'is "' +
      spelled +
      '", which is none of the four forms contract ' +
      CONTRACT.toString() +
      " fixes — reading it as some other kind would let this rule judge a record it had misread",
  );
  return ImportKind.Static;
}

function readSpelling(reading: Reading, row: JsonValue, path: string): Spelling {
  const spelling = new Spelling();
  const object = readObject(reading, row, "spelling", path + ".spelling");
  if (reading.failed) return spelling;
  spelling.path = readBool(reading, object, "path", path + ".spelling.path");
  spelling.relative = readBool(reading, object, "relative", path + ".spelling.relative");
  return spelling;
}

function readResolved(reading: Reading, row: JsonValue, path: string): Resolved | null {
  const value = row.get("resolved");
  if (value == null) {
    reading.fail(
      path + ".resolved",
      "is absent — an import site the analyzer could not resolve states null, and an absent " +
        "member is a bundle that never recorded the blind spot",
    );
    return null;
  }
  if (value.isNull) return null;
  if (!value.isObject) {
    reading.fail(path + ".resolved", "is neither an object nor null");
    return null;
  }
  const resolved = new Resolved();
  resolved.target = readNullableString(reading, value, "target", path + ".resolved.target");
  resolved.file = readNullableString(reading, value, "file", path + ".resolved.file");
  resolved.external = readBool(reading, value, "external", path + ".resolved.external");
  resolved.packageName = readNullableString(
    reading,
    value,
    "packageName",
    path + ".resolved.packageName",
  );
  return resolved;
}

function readPolicy(reading: Reading, root: JsonValue): Policy {
  const policy = new Policy();
  const object = readObject(reading, root, "policy", "policy");
  if (reading.failed) return policy;
  policy.depConstraints = readArray(reading, object, "depConstraints", "policy.depConstraints");
  policy.moduleBoundaryOptions = readObject(
    reading,
    object,
    "moduleBoundaryOptions",
    "policy.moduleBoundaryOptions",
  );
  return policy;
}
