/**
 * Who can reach whom in the project graph — the traversal two different rules
 * need, so it lives beside neither of them.
 *
 * `noCircularDependencies` asks whether a path leads from the import's target
 * back to its source, and `notDependOnLibsWithTags` asks which tagged projects
 * are reachable FROM the target (upstream checks the whole transitive closure,
 * not just the project being imported — see `../rules/tags.mjs`). Both are the
 * same reachability question, and a second copy of it in the second rule is how
 * two answers to one question start disagreeing.
 *
 * Ported from `@nx/eslint-plugin`'s `utils/graph-utils`, including the exact
 * traversal order of `getPath`: the path it returns is interpolated into the
 * `noCircularDependencies` message, so a different-but-equally-valid path would
 * make a differential comparison against ESLint fail on text alone.
 *
 * Upstream caches the matrix on a module-level `reach` object keyed by graph
 * identity. This builds it once per `evaluate` call and hands it down instead:
 * a module-level cache in a module advertised as pure functions is state a
 * caller cannot see, and the tool's second surface (a language server holding
 * several graph revisions) is exactly where that bites.
 */

/**
 * The adjacency list and full reachability matrix of a graph's PROJECT nodes.
 * External (npm) nodes are excluded, as upstream excludes them: `adjList` only
 * takes an edge whose target is a project node.
 *
 * @param {object} graph
 * @returns {{ adjList: Record<string, string[]>, matrix: Record<string, Record<string, boolean>> }}
 */
export function buildReachability(graph) {
  // Bound once so the membership test below asks the SAME map `nodes` was
  // derived from, and so a graph that is only a shape (`buildReachability({})`)
  // still answers instead of throwing.
  const nodeMap = graph.nodes ?? {};
  const nodes = Object.keys(nodeMap);
  // Null-prototype for the same reason `../providers/native/graph.mjs` uses
  // them: every key here is a project NAME, and project names come from the
  // graph the caller built from attacker-controlled manifests — a plain `{}`
  // would let a project literally named `__proto__` repoint the map's OWN
  // prototype instead of adding an entry. The project then vanishes from the
  // closure: `adjList["__proto__"]` reads the poisoned prototype (a Node
  // object), `.filter`/`.push` are not functions, and the whole reachability
  // walk throws `TypeError: adjList[current].filter is not a function` —
  // exactly the diagnostic an LSP editor published in place of a boundary
  // verdict. The matrix ROWS need the same protection as the outer maps: a
  // row that is a plain `{}` reads `matrix[start][adj]` truthy whenever `adj`
  // is `__proto__` (the inherited accessor answers `Object.prototype`), so the
  // walk's `continue` skips the hop AND the write `matrix[start][__proto__]`
  // is a no-op — one poisoned name silently cancels the whole walk through it.
  /** @type {Record<string, string[]>} */
  const adjList = Object.create(null);
  /** @type {Record<string, Record<string, boolean>>} */
  const matrix = Object.create(null);
  for (const name of nodes) {
    adjList[name] = [];
    // Null-prototype rows: `matrix[name]` is keyed by project NAME too, and a
    // project named `__proto__` must be a real, own, enumerable entry in it —
    // the closure depends on both the read and the write behaving like any
    // other project name (`Object.create(null)`'s absence of the inherited
    // `__proto__` accessor is what makes the assignment add an entry instead
    // of no-op on the prototype setter).
    matrix[name] = Object.create(null);
  }
  for (const [source, dependencies] of Object.entries(graph.dependencies ?? {})) {
    // Upstream indexes `adjList[dependency.source]` unguarded and throws on a
    // dependency whose source is not a node. Skipping is the defensive
    // difference: a graph half-built by a caller must not crash the enforcer
    // into reporting nothing at all.
    if (!adjList[source]) continue;
    for (const dependency of dependencies ?? []) {
      // `Object.hasOwn`, never `nodeMap[target]`: the caller's node map is
      // usually a plain object (`JSON.parse` of `nx graph --file=`), so a
      // truthiness test on it answers `constructor`, `toString`, `valueOf`,
      // `hasOwnProperty` and `__proto__` from `Object.prototype` and admits an
      // edge to a project that does not exist. That is not a quiet
      // over-approximation here, it is a crash: `adjList` is null-prototype (by
      // design, just above), so the phantom name gets pushed as a neighbour and
      // then `adjList["constructor"]` reads back `undefined` on the very next
      // hop — measured, `TypeError: adjList[current] is not iterable`, which
      // takes down every rule that needs the closure and publishes a stack
      // trace where a boundary verdict belonged. The `__proto__` sibling was
      // already pinned; these four were not, because the prototype answers for
      // them through inheritance rather than through the `__proto__` accessor.
      if (Object.hasOwn(nodeMap, dependency.target)) adjList[source].push(dependency.target);
    }
  }
  // Upstream's `traverse` is recursive; this is the same depth-first closure
  // with an explicit stack, so a deep graph cannot overflow the call stack.
  for (const start of nodes) {
    const stack = [start];
    matrix[start][start] = true;
    while (stack.length > 0) {
      const current = stack.pop();
      for (const adj of adjList[current]) {
        if (matrix[start][adj]) continue;
        matrix[start][adj] = true;
        stack.push(adj);
      }
    }
  }
  return { adjList, matrix };
}

/**
 * Is `target` reachable from `source`? A project always reaches itself, which
 * is what makes `findDependenciesWithTags` include the imported project itself.
 *
 * @param {{matrix: Record<string, Record<string, boolean>>}} reach
 * @param {string} sourceProjectName
 * @param {string} targetProjectName
 * @returns {boolean}
 */
export function pathExists(reach, sourceProjectName, targetProjectName) {
  if (sourceProjectName === targetProjectName) return true;
  return !!reach.matrix[sourceProjectName]?.[targetProjectName];
}

/**
 * The nodes on a path from `sourceProjectName` to `targetProjectName`, or `[]`
 * when none exists.
 *
 * Ported move for move from upstream, `queue.pop()` included — that turns the
 * nominal breadth-first queue into a depth-first walk, and the resulting path
 * is what the circular-dependency message prints.
 *
 * @returns {object[]} project nodes, source first.
 */
export function getPath(reach, graph, sourceProjectName, targetProjectName) {
  if (sourceProjectName === targetProjectName) return [];
  const { adjList, matrix } = reach;
  let path = [];
  const queue = [[sourceProjectName, path]];
  const visited = [sourceProjectName];

  while (queue.length > 0) {
    const [current, p] = queue.pop();
    path = [...p, current];
    if (current === targetProjectName) break;
    if (!adjList[current]) break;
    adjList[current]
      .slice()
      .sort()
      .filter((adj) => visited.indexOf(adj) === -1)
      .filter((adj) => matrix[adj]?.[targetProjectName])
      .forEach((adj) => {
        visited.push(adj);
        queue.push([adj, [...path]]);
      });
  }
  return path.length > 1 ? path.map((n) => graph.nodes[n]) : [];
}

/**
 * The cycle an import would close: a path from the TARGET back to the SOURCE.
 * Empty when the import creates no cycle.
 *
 * The direction is the subtle half. The edge being judged is source → target;
 * a cycle exists only if the graph already carries a way back, so upstream asks
 * for the reverse path and never adds the new edge to the graph first.
 */
export function checkCircularPath(reach, graph, sourceProject, targetProject) {
  // `Object.hasOwn` for the same reason `buildReachability` above uses it: this
  // guard exists to refuse a target the graph does not contain, and a
  // truthiness test on a plain node map answers `constructor`/`toString` and
  // friends from `Object.prototype` — so the guard let exactly the names it was
  // written to stop walk straight past it.
  if (!Object.hasOwn(graph.nodes ?? {}, targetProject.name)) return [];
  return getPath(reach, graph, targetProject.name, sourceProject.name);
}

/**
 * Does any consecutive pair on this path appear in the ignore map? Checked
 * pairwise rather than end to end, so ignoring one hop excuses every cycle
 * running through it.
 *
 * @param {{name: string}[]} circularPath
 * @param {Map<string, Set<string>>} ignored
 * @returns {boolean}
 */
export function circularPathHasPair(circularPath, ignored) {
  if (circularPath.length < 2) return false;
  for (let i = 0; i < circularPath.length - 1; i++) {
    if (ignored.get(circularPath[i].name)?.has(circularPath[i + 1].name)) return true;
  }
  return false;
}

/**
 * Expands `ignoredCircularDependencies` pairs into the symmetric map the
 * pairwise check reads. Both directions are recorded, because upstream records
 * both: ignoring `[a, b]` excuses `a → b` and `b → a`.
 *
 * @param {[string, string][]} ignoredCircularDependencies
 * @param {object} graph
 * @param {(patterns: string[], nodes: object) => string[]} findMatchingProjects
 *   Injected rather than imported so this module keeps knowing only about
 *   graphs; `../config.mjs` has already rejected any pattern the matcher cannot
 *   reproduce, so a throw from here means validation was skipped.
 * @returns {Map<string, Set<string>>}
 */
export function expandIgnoredCircularDependencies(
  ignoredCircularDependencies,
  graph,
  findMatchingProjects,
) {
  const allowed = new Map();
  const add = (from, to) => {
    if (!allowed.has(from)) allowed.set(from, new Set());
    allowed.get(from).add(to);
  };
  for (const [a, b] of ignoredCircularDependencies) {
    const setA = findMatchingProjects([a], graph.nodes);
    const setB = findMatchingProjects([b], graph.nodes);
    for (const projectA of setA) {
      if (!allowed.has(projectA)) allowed.set(projectA, new Set());
      for (const projectB of setB) add(projectA, projectB);
    }
    for (const projectB of setB) {
      if (!allowed.has(projectB)) allowed.set(projectB, new Set());
      for (const projectA of setA) add(projectB, projectA);
    }
  }
  return allowed;
}
