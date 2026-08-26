//! Fan-out/fan-in computation over the evidence graph.
//!
//! Shared by topology rules: max-fan-out and max-fan-in.
//! Self-edges are skipped — providers never emit them, but replayed bundles
//! might carry them, and a project is not its own dependency.

use archkeep_rule_sdk::{Edge, Project};
use std::collections::BTreeSet;

/// Validates that every edge endpoint is declared in the project list.
///
/// Returns `Err` naming the first undeclared endpoint; otherwise `Ok(())`.
/// Both fan_out and fan_in refuse to compute counts on a half-declared graph —
/// model/graph disagreement is `unknown`, never a partial count.
fn validate_endpoints(projects: &[Project], edges: &[Edge]) -> Result<(), String> {
    let declared_projects: BTreeSet<&str> = projects.iter().map(|p| p.name.as_str()).collect();

    for edge in edges {
        if !declared_projects.contains(edge.source.as_str()) {
            return Err(format!(
                "the graph carries an edge out of \"{}\", which the model does not declare",
                edge.source
            ));
        }
        if !declared_projects.contains(edge.target.as_str()) {
            return Err(format!(
                "the graph carries an edge into \"{}\", which the model does not declare",
                edge.target
            ));
        }
    }
    Ok(())
}

/// Computes per-project distinct outgoing dependency counts.
///
/// # Returns
///
/// For each project in `model.projects` (in model order):
/// - Reference to the project
/// - Count of DISTINCT outgoing targets
/// - Sorted list of target project names
///
/// # Errors
///
/// Returns `Err` if ANY edge names a source or target not declared in
/// `model.projects` — model/graph disagreement is `unknown`, never a count.
#[allow(clippy::type_complexity)]
pub fn fan_out<'a>(
    projects: &'a [Project],
    edges: &'a [Edge],
) -> Result<Vec<(&'a Project, usize, Vec<&'a str>)>, String> {
    // Validate ALL edges first: every endpoint must be declared in the model.
    // An edge naming an undeclared project means the evidence halves disagree,
    // and the honest answer is `unknown` rather than a count computed over half a graph.
    validate_endpoints(projects, edges)?;

    // For each project in model order, collect distinct outgoing targets.
    let mut result = Vec::with_capacity(projects.len());

    for project in projects {
        let mut distinct_targets = BTreeSet::new();

        for edge in edges {
            // Skip self-edges — a project is not its own dependency.
            if edge.source == edge.target {
                continue;
            }

            if edge.source == project.name {
                distinct_targets.insert(edge.target.as_str());
            }
        }

        let count = distinct_targets.len();
        let targets: Vec<&str> = distinct_targets.into_iter().collect();

        result.push((project, count, targets));
    }

    Ok(result)
}

/// Computes per-project distinct incoming source counts.
///
/// # Returns
///
/// For each project in `model.projects` (in model order):
/// - Reference to the project
/// - Count of DISTINCT incoming sources (projects that depend on it)
/// - Sorted list of source project names
///
/// # Errors
///
/// Returns `Err` if ANY edge names a source or target not declared in
/// `model.projects` — model/graph disagreement is `unknown`, never a count.
#[allow(clippy::type_complexity)]
pub fn fan_in<'a>(
    projects: &'a [Project],
    edges: &'a [Edge],
) -> Result<Vec<(&'a Project, usize, Vec<&'a str>)>, String> {
    // Validate ALL edges first: every endpoint must be declared in the model.
    // An edge naming an undeclared project means the evidence halves disagree,
    // and the honest answer is `unknown` rather than a count computed over half a graph.
    validate_endpoints(projects, edges)?;

    // For each project in model order, collect distinct incoming sources.
    let mut result = Vec::with_capacity(projects.len());

    for project in projects {
        let mut distinct_sources = BTreeSet::new();

        for edge in edges {
            // Skip self-edges — a project is not its own dependency.
            if edge.source == edge.target {
                continue;
            }

            if edge.target == project.name {
                distinct_sources.insert(edge.source.as_str());
            }
        }

        let count = distinct_sources.len();
        let sources: Vec<&str> = distinct_sources.into_iter().collect();

        result.push((project, count, sources));
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str) -> Project {
        Project {
            name: name.to_string(),
            root: format!("packages/{}", name),
            tags: vec![],
        }
    }

    fn edge(source: &str, target: &str, edge_type: &str) -> Edge {
        Edge {
            source: source.to_string(),
            target: target.to_string(),
            edge_type: edge_type.to_string(),
            source_file: None,
        }
    }

    #[test]
    fn empty_graph_yields_zero_counts_for_all_projects() {
        let projects = vec![project("alpha"), project("beta")];
        let edges: Vec<Edge> = vec![];

        let result = fan_out(&projects, &edges).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].1, 0); // alpha: 0 targets
        assert_eq!(result[1].1, 0); // beta: 0 targets
        assert_eq!(result[0].0.name, "alpha"); // model order preserved
        assert_eq!(result[1].0.name, "beta");
    }

    #[test]
    fn counts_distinct_targets_per_project_in_model_order() {
        let projects = vec![project("alpha"), project("beta"), project("gamma")];
        let edges = vec![
            edge("alpha", "beta", "static"),
            edge("alpha", "gamma", "static"),
            edge("beta", "gamma", "static"),
        ];

        let result = fan_out(&projects, &edges).unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(result[0].0.name, "alpha");
        assert_eq!(result[0].1, 2); // alpha → beta, gamma
        assert_eq!(result[0].2, vec!["beta", "gamma"]);

        assert_eq!(result[1].0.name, "beta");
        assert_eq!(result[1].1, 1); // beta → gamma
        assert_eq!(result[1].2, vec!["gamma"]);

        assert_eq!(result[2].0.name, "gamma");
        assert_eq!(result[2].1, 0); // gamma has no outgoing edges
        assert_eq!(result[2].2, Vec::<&str>::new()); // Empty vec for no dependencies
    }

    #[test]
    fn duplicate_edges_to_same_target_count_once() {
        let projects = vec![project("source"), project("target")];
        let edges = vec![
            edge("source", "target", "static"),
            edge("source", "target", "dynamic"), // Same target, different type
        ];

        let result = fan_out(&projects, &edges).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0.name, "source");
        assert_eq!(result[0].1, 1); // Count distinct targets, not edges
        assert_eq!(result[0].2, vec!["target"]);
    }

    #[test]
    fn self_edges_are_skipped() {
        let projects = vec![project("hub"), project("leaf")];
        let edges = vec![
            edge("hub", "hub", "static"),  // self-edge (skipped)
            edge("hub", "leaf", "static"), // real edge (counted)
        ];

        let result = fan_out(&projects, &edges).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0.name, "hub");
        assert_eq!(result[0].1, 1); // Only leaf counted, self-edge skipped
        assert_eq!(result[0].2, vec!["leaf"]);
    }

    #[test]
    fn undeclared_source_endpoint_returns_error() {
        let projects = vec![project("alpha")];
        let edges = vec![edge("ghost", "alpha", "static")]; // ghost not declared

        let result = fan_out(&projects, &edges);

        assert!(result.is_err());
        assert!(result.as_ref().unwrap_err().contains("ghost"));
        assert!(result.as_ref().unwrap_err().contains("does not declare"));
    }

    #[test]
    fn undeclared_target_endpoint_returns_error() {
        let projects = vec![project("alpha")];
        let edges = vec![edge("alpha", "ghost", "static")]; // ghost not declared

        let result = fan_out(&projects, &edges);

        assert!(result.is_err());
        assert!(result.as_ref().unwrap_err().contains("ghost"));
        assert!(result.as_ref().unwrap_err().contains("does not declare"));
    }

    #[test]
    fn targets_are_sorted_alphabetically() {
        let projects = vec![
            project("hub"),
            project("zebra"),
            project("alpha"),
            project("beta"),
        ];
        let edges = vec![
            edge("hub", "zebra", "static"),
            edge("hub", "alpha", "static"),
            edge("hub", "beta", "static"),
        ];

        let result = fan_out(&projects, &edges).unwrap();

        assert_eq!(result[0].2, vec!["alpha", "beta", "zebra"]); // BTreeSet guarantees sorted order
    }

    // --- fan_in tests ---

    #[test]
    fn fan_in_empty_graph_yields_zero_counts_for_all_projects() {
        let projects = vec![project("alpha"), project("beta")];
        let edges: Vec<Edge> = vec![];

        let result = fan_in(&projects, &edges).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].1, 0); // alpha: 0 sources
        assert_eq!(result[1].1, 0); // beta: 0 sources
        assert_eq!(result[0].0.name, "alpha"); // model order preserved
        assert_eq!(result[1].0.name, "beta");
    }

    #[test]
    fn fan_in_counts_distinct_sources_per_project_in_model_order() {
        let projects = vec![project("alpha"), project("beta"), project("gamma")];
        let edges = vec![
            edge("alpha", "beta", "static"),
            edge("alpha", "gamma", "static"),
            edge("beta", "gamma", "static"),
        ];

        let result = fan_in(&projects, &edges).unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(result[0].0.name, "alpha");
        assert_eq!(result[0].1, 0); // alpha has no incoming edges

        assert_eq!(result[1].0.name, "beta");
        assert_eq!(result[1].1, 1); // beta ← alpha
        assert_eq!(result[1].2, vec!["alpha"]);

        assert_eq!(result[2].0.name, "gamma");
        assert_eq!(result[2].1, 2); // gamma ← alpha, beta
        assert_eq!(result[2].2, vec!["alpha", "beta"]);
    }

    #[test]
    fn fan_in_duplicate_edges_from_same_source_count_once() {
        let projects = vec![project("source"), project("target")];
        let edges = vec![
            edge("source", "target", "static"),
            edge("source", "target", "dynamic"), // Same source, different type
        ];

        let result = fan_in(&projects, &edges).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[1].0.name, "target");
        assert_eq!(result[1].1, 1); // Count distinct sources, not edges
        assert_eq!(result[1].2, vec!["source"]);
    }

    #[test]
    fn fan_in_self_edges_are_skipped() {
        let projects = vec![project("hub"), project("leaf")];
        let edges = vec![
            edge("hub", "hub", "static"),  // self-edge (skipped)
            edge("leaf", "hub", "static"), // real edge (counted)
        ];

        let result = fan_in(&projects, &edges).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0.name, "hub");
        assert_eq!(result[0].1, 1); // Only leaf counted, self-edge skipped
        assert_eq!(result[0].2, vec!["leaf"]);
    }

    #[test]
    fn fan_in_undeclared_source_endpoint_returns_error() {
        let projects = vec![project("alpha")];
        let edges = vec![edge("ghost", "alpha", "static")]; // ghost not declared

        let result = fan_in(&projects, &edges);

        assert!(result.is_err());
        assert!(result.as_ref().unwrap_err().contains("ghost"));
        assert!(result.as_ref().unwrap_err().contains("does not declare"));
    }

    #[test]
    fn fan_in_undeclared_target_endpoint_returns_error() {
        let projects = vec![project("alpha")];
        let edges = vec![edge("alpha", "ghost", "static")]; // ghost not declared

        let result = fan_in(&projects, &edges);

        assert!(result.is_err());
        assert!(result.as_ref().unwrap_err().contains("ghost"));
        assert!(result.as_ref().unwrap_err().contains("does not declare"));
    }

    #[test]
    fn fan_in_sources_are_sorted_alphabetically() {
        let projects = vec![
            project("target"),
            project("zebra"),
            project("alpha"),
            project("beta"),
        ];
        let edges = vec![
            edge("zebra", "target", "static"),
            edge("alpha", "target", "static"),
            edge("beta", "target", "static"),
        ];

        let result = fan_in(&projects, &edges).unwrap();

        assert_eq!(result[0].2, vec!["alpha", "beta", "zebra"]); // BTreeSet guarantees sorted order
    }
}
