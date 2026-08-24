//! The evidence bundle, typed.
//!
//! Every field name and every optionality below is read off the engine's own
//! assembly (`../../archkeep/src/custom-rules/evidence.mjs`) and the frozen
//! record it copies through (`../../archkeep/src/analysis/contract.md`). The
//! bundle is the wire, not the engine's internals: `../../archkeep/src/config.mjs`
//! calls the eight boundary settings `options` and the bundle renames them to
//! `moduleBoundaryOptions` — the name the workspace itself wrote — so that is
//! the name here too.
//!
//! ## Unknown fields are accepted, unknown VALUES are not
//!
//! No struct here carries `deny_unknown_fields`. The evidence contract "grows
//! additively within a version"
//! (`../../../docs/adr/0002-custom-rules-one-contract.md`, Consequences), so a
//! rule compiled today must keep reading a bundle that gained a field
//! tomorrow — refusing it would make every existing rule `unknown` on an engine
//! upgrade that added nothing they read.
//!
//! An unknown VALUE is the opposite case. [`ImportKind`] is a closed enum
//! because `../../archkeep/src/analysis/contract.md` fixes those four kinds, and
//! a fifth one arriving is a contract change a rule must be rebuilt for. Reading
//! it as "some other kind" would let a rule judge a record it had misread; the
//! deserialization error it produces instead becomes an `unknown` verdict that
//! names the field ([`crate::abi::evaluate_json`]), which is the loud direction.

use std::num::NonZeroU32;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::CONTRACT;

/// Everything a rule is handed, and the only thing it is ever handed.
#[derive(Debug, Clone, Deserialize)]
pub struct Evidence {
    /// The contract version the bundle states. Always [`crate::CONTRACT`] by
    /// the time a rule sees it — [`Evidence::from_slice`] refuses anything
    /// else rather than reading a document it was not built against.
    pub contract: u32,
    /// Which rule this bundle was built for, and the parameters its policy row
    /// declared.
    pub rule: RuleInstance,
    /// The project model.
    pub model: Model,
    /// The dependency graph.
    pub graph: Graph,
    /// Every import site the analyzers read, each attributed to the project
    /// that owns the importing file. In source order, which is part of the
    /// analysis contract rather than an accident — the engine deliberately does
    /// not sort this array.
    pub imports: Vec<ImportRecord>,
    /// The loaded policy.
    pub policy: Policy,
}

/// The declared rule row, as the bundle carries it.
#[derive(Debug, Clone, Deserialize)]
pub struct RuleInstance {
    /// The name the policy row declared, which is also the name this artifact's
    /// own declaration must state.
    pub name: String,
    /// The row's `params`, verbatim. `{}` when the row declared none — the
    /// engine writes that default into the BUNDLE and never back onto the
    /// policy, so a rule reading an empty object cannot tell whether the
    /// workspace wrote `params: {}` or omitted the field, and must not need to.
    pub params: Value,
}

/// The `model` kind: every project the run covers, sorted by name.
#[derive(Debug, Clone, Deserialize)]
pub struct Model {
    /// The projects, in name order.
    pub projects: Vec<Project>,
}

/// One project, as the workspace's provider reported it.
#[derive(Debug, Clone, Deserialize)]
pub struct Project {
    /// The project's name — the identity every edge and every attribution uses.
    pub name: String,
    /// The project's root, workspace-relative.
    pub root: String,
    /// The project's tags, verbatim. An untagged project carries `[]`; the
    /// engine refuses to build a bundle in which "no tags" and "tags were never
    /// read" look the same, so an empty list here is a fact.
    pub tags: Vec<String>,
}

impl Project {
    /// Whether this project carries `tag`, compared exactly.
    ///
    /// Exact rather than prefix- or glob-matched on purpose: a tag vocabulary
    /// belongs to the workspace, and a rule that matched `layer-` loosely would
    /// be inventing a grammar the workspace never agreed to.
    #[must_use]
    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags.iter().any(|carried| carried == tag)
    }
}

/// The `graph` kind: every edge between two projects, sorted by source, target,
/// type, then source file.
#[derive(Debug, Clone, Deserialize)]
pub struct Graph {
    /// The edges, in the order above.
    pub edges: Vec<Edge>,
}

/// One dependency edge.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    /// The depending project's name.
    pub source: String,
    /// The depended-on project's name.
    pub target: String,
    /// How the dependency was established — `"static"`, and whatever else the
    /// workspace's own provider emits.
    ///
    /// A `String` rather than an enum, because this vocabulary is the graph
    /// provider's (Nx's, Moon's, or the native model's) and not something
    /// contract 1 fixes. An enum here would refuse a workspace whose provider
    /// spells a type this crate had never heard of, which is a rule failing on
    /// a fact it did not need.
    #[serde(rename = "type")]
    pub edge_type: String,
    /// The file the dependency was read from, when the provider carried one.
    /// Absent is normal: `nx graph --file=` emits no `sourceFile` on any edge.
    #[serde(default)]
    pub source_file: Option<String>,
}

/// How an import was written — the four forms the analysis contract fixes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportKind {
    /// A top-level `import`/`require`/`use`/Go import declaration.
    Static,
    /// `import()` and its per-language equivalents.
    Dynamic,
    /// Erased before runtime (`import type`), so it creates no runtime
    /// dependency.
    TypeOnly,
    /// `export … from` — an import and a re-publish in one statement.
    ReExport,
}

/// How a specifier is spelled, in the language it was written in.
///
/// Two independent bits, because the rules ask two independent questions, and
/// both are answered by the analyzer that already knows the language rather
/// than derived downstream from the text.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Spelling {
    /// The specifier is a filesystem path, resolvable by path arithmetic
    /// against the importing file, and names no package.
    pub path: bool,
    /// The specifier reaches inside its own project without going out through
    /// the project's public name.
    pub relative: bool,
}

/// Where a specifier points, when the analyzer could say.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// The project the specifier resolves into, or `None` when it resolves
    /// outside every project.
    pub target: Option<String>,
    /// The workspace-relative file it resolves to, or `None` when resolution
    /// stops at a package rather than a file.
    pub file: Option<String>,
    /// `true` when the specifier resolves outside every project.
    pub external: bool,
    /// The package's own name when external — `@scope/name`, not the deep
    /// path, which is what a `bannedExternalImports` glob is matched against.
    pub package_name: Option<String>,
}

/// One import site: one written import, not one resolved dependency. A file
/// importing the same project three times yields three of these.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    /// The project owning the importing file. Added by the engine from the
    /// workspace's files-per-project map — the only layer allowed to answer
    /// which project owns which file — never re-derived from a root prefix.
    pub source_project: String,
    /// The importing file, workspace-relative.
    pub source_file: String,
    /// 1-based line of the import site.
    pub line: u32,
    /// 1-based column of the import site.
    pub column: u32,
    /// The raw specifier, exactly as written. Five of the fifteen upstream
    /// boundary violations are decided on this text rather than on the project
    /// pair it resolves to, which is why the record keeps it.
    pub specifier: String,
    /// The form the import takes.
    pub kind: ImportKind,
    /// How the specifier is spelled.
    pub spelling: Spelling,
    /// Where it points, or `None` when the analyzer could not say. `None` is a
    /// recorded blind spot, never a dropped record and never a guess.
    pub resolved: Option<Resolved>,
}

impl ImportRecord {
    /// This site's position, ready to hand to [`crate::Finding::at`].
    ///
    /// `None` when either coordinate is zero, which the engine never emits —
    /// every position this tool reports is 1-based
    /// (`../../archkeep/src/analysis/contract.md`). Returning an `Option`
    /// rather than clamping keeps a malformed bundle from producing a finding
    /// that points at a line no file has.
    #[must_use]
    pub fn position(&self) -> Option<(NonZeroU32, NonZeroU32)> {
        Some((NonZeroU32::new(self.line)?, NonZeroU32::new(self.column)?))
    }
}

/// The `policy` kind: the two fields contract 1 carries of a loaded policy.
///
/// Both are [`Value`], and that is a decision rather than laziness. The
/// constraint row schema has exactly one owner
/// (`../../archkeep/src/config.mjs`, which validates it at load), and a second
/// model of it here would be a dialect: it would drift the first time a
/// governance key was added, and a rule reading through it would be judging a
/// policy the engine had already read differently.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// The constraint rows, in the order the workspace wrote them — order is
    /// semantic for a boundary policy, so the engine deliberately does not sort
    /// this array.
    pub dep_constraints: Vec<Value>,
    /// The eight `@nx/enforce-module-boundaries` settings, as the workspace
    /// stated them.
    pub module_boundary_options: Value,
}

/// Why an evidence bundle could not be read.
///
/// Both variants end the same way — an `unknown` verdict naming the cause
/// ([`crate::abi::evaluate_json`]) — but they are separate variants because
/// they are separate accusations: one says the bytes are not the document, the
/// other says the document is not this contract.
#[derive(Debug)]
pub enum EvidenceError {
    /// The bytes are not the JSON document contract 1 describes.
    Malformed(serde_json::Error),
    /// The bundle states a contract version this SDK was not built against.
    Contract {
        /// The version the bundle stated.
        stated: u32,
    },
}

impl std::fmt::Display for EvidenceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(error) => write!(
                formatter,
                "the evidence bundle could not be read as contract {CONTRACT} ({error})"
            ),
            Self::Contract { stated } => write!(
                formatter,
                "the evidence bundle states contract {stated} and this rule was built against \
                 contract {CONTRACT} — a rule built for another contract is not approximated"
            ),
        }
    }
}

impl std::error::Error for EvidenceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Malformed(error) => Some(error),
            Self::Contract { .. } => None,
        }
    }
}

impl Evidence {
    /// Reads a bundle from the bytes the host wrote into linear memory.
    ///
    /// # Errors
    ///
    /// [`EvidenceError::Malformed`] when the bytes are not the document, and
    /// [`EvidenceError::Contract`] when they are a document from a version this
    /// rule was not built against. Neither is recoverable inside a rule, and
    /// neither may be read as "nothing found".
    pub fn from_slice(bytes: &[u8]) -> Result<Self, EvidenceError> {
        let bundle: Self = serde_json::from_slice(bytes).map_err(EvidenceError::Malformed)?;
        if bundle.contract != CONTRACT {
            return Err(EvidenceError::Contract {
                stated: bundle.contract,
            });
        }
        Ok(bundle)
    }

    /// The rule row's `params`, deserialized into the author's own type.
    ///
    /// The alternative — reading [`Value`] by hand — stays available and is
    /// what `examples/forbidden_tag_dependency.rs` uses, because it needs no
    /// `serde` derive in the author's crate. This is here for rules whose
    /// parameters have more than one field, where a typed struct is the shorter
    /// and safer read.
    ///
    /// # Errors
    ///
    /// The deserialization error, which an author turns into an `unknown`
    /// verdict naming what the row should have said. A missing or mistyped
    /// parameter must never become a `pass`.
    pub fn params<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        T::deserialize(&self.rule.params)
    }

    /// The project of this name, or `None`.
    ///
    /// `None` is the case a rule has to answer for rather than skip: an edge
    /// naming a project the model does not carry means the two halves of the
    /// evidence disagree, and a rule that silently ignored the edge would be
    /// reporting a clean workspace it never finished reading.
    #[must_use]
    pub fn project(&self, name: &str) -> Option<&Project> {
        self.model
            .projects
            .iter()
            .find(|project| project.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::{Evidence, EvidenceError, ImportKind};
    use serde::Deserialize;

    /// The smallest bundle that is still a whole one — every kind present,
    /// because the engine refuses to build a bundle with a kind missing.
    const MINIMAL: &str = r#"{
        "contract": 1,
        "rule": { "name": "example-rule", "params": { "tag": "layer-domain" } },
        "model": { "projects": [{ "name": "alpha", "root": "packages/alpha", "tags": ["layer-domain"] }] },
        "graph": { "edges": [{ "source": "beta", "target": "alpha", "type": "static" }] },
        "imports": [{
            "sourceProject": "beta",
            "sourceFile": "packages/beta/src/lib.rs",
            "line": 3,
            "column": 5,
            "specifier": "alpha::thing",
            "kind": "static",
            "spelling": { "path": false, "relative": false },
            "resolved": { "target": "alpha", "file": null, "external": false, "packageName": null }
        }],
        "policy": { "depConstraints": [], "moduleBoundaryOptions": { "allow": [] } }
    }"#;

    #[test]
    fn a_whole_bundle_reads_every_kind() {
        let evidence = Evidence::from_slice(MINIMAL.as_bytes()).expect("the fixture is a bundle");
        assert_eq!(evidence.rule.name, "example-rule");
        assert!(
            evidence
                .project("alpha")
                .expect("declared")
                .has_tag("layer-domain")
        );
        assert!(evidence.project("beta").is_none());
        assert_eq!(evidence.graph.edges[0].edge_type, "static");
        assert!(evidence.graph.edges[0].source_file.is_none());
        assert_eq!(evidence.imports[0].kind, ImportKind::Static);
        assert_eq!(evidence.imports[0].source_project, "beta");
        assert_eq!(
            evidence.imports[0]
                .resolved
                .as_ref()
                .expect("resolved")
                .target
                .as_deref(),
            Some("alpha")
        );
        assert!(evidence.policy.dep_constraints.is_empty());
    }

    #[test]
    fn positions_are_one_based_and_zero_is_refused() {
        let evidence = Evidence::from_slice(MINIMAL.as_bytes()).expect("the fixture is a bundle");
        let (line, column) = evidence.imports[0].position().expect("1-based");
        assert_eq!((line.get(), column.get()), (3, 5));

        let zeroed = MINIMAL.replace("\"line\": 3", "\"line\": 0");
        let evidence = Evidence::from_slice(zeroed.as_bytes()).expect("still a bundle");
        assert!(evidence.imports[0].position().is_none());
    }

    #[test]
    fn typed_params_read_the_row() {
        #[derive(Deserialize)]
        struct Params {
            tag: String,
        }
        let evidence = Evidence::from_slice(MINIMAL.as_bytes()).expect("the fixture is a bundle");
        let params: Params = evidence.params().expect("the row declares a tag");
        assert_eq!(params.tag, "layer-domain");
    }

    // The silent direction, three ways: none of these may read as a bundle,
    // because every one of them would hand a rule facts it could then judge
    // over and report clean.
    #[test]
    fn a_bundle_from_another_contract_is_refused_by_version() {
        let other = MINIMAL.replace("\"contract\": 1", "\"contract\": 2");
        match Evidence::from_slice(other.as_bytes()) {
            Err(EvidenceError::Contract { stated }) => assert_eq!(stated, 2),
            other => panic!("a contract-2 bundle must be refused by version, got {other:?}"),
        }
    }

    #[test]
    fn a_bundle_missing_a_kind_is_refused() {
        let without_model = MINIMAL.replace("\"model\"", "\"modelling\"");
        assert!(matches!(
            Evidence::from_slice(without_model.as_bytes()),
            Err(EvidenceError::Malformed(_))
        ));
    }

    #[test]
    fn an_import_kind_this_contract_does_not_carry_is_refused() {
        let invented = MINIMAL.replace("\"kind\": \"static\"", "\"kind\": \"ambient\"");
        assert!(matches!(
            Evidence::from_slice(invented.as_bytes()),
            Err(EvidenceError::Malformed(_))
        ));
    }

    #[test]
    fn a_field_this_contract_does_not_carry_yet_is_accepted() {
        // The additive-growth half: an engine that adds a field must not turn
        // every already-built rule `unknown`.
        let grown = MINIMAL.replace(
            "\"type\": \"static\"",
            "\"type\": \"static\", \"weight\": 3",
        );
        assert!(Evidence::from_slice(grown.as_bytes()).is_ok());
    }
}
