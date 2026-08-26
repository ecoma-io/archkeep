import { describe, expect, it } from "vitest";

import {
  interpolateCoordinate,
  mavenConfigProperties,
  mavenManifestFailures,
  mavenModelOf,
  parentPomPath,
  parsePomProject,
  pomEntryOf,
  resolveMavenDependencies,
} from "./maven.mjs";

/** An in-memory workspace: one project per directory holding a pom.xml. */
const workspaceOf = (files) => {
  const dirs = [
    ...new Set(
      Object.keys(files)
        .filter((file) => file === "pom.xml" || file.endsWith("/pom.xml"))
        .map((file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "")),
    ),
  ];
  const projects = dirs.map((dir) => ({
    name: dir === "" ? "root" : dir.split("/").join("-"),
    root: dir,
  }));
  return {
    root: "/workspace",
    projects,
    filesOf: (name) => {
      const project = projects.find((candidate) => candidate.name === name);
      if (!project) return [];
      return Object.keys(files).filter(
        (file) => project.root === "" || file.startsWith(`${project.root}/`),
      );
    },
    readFile: (path) => files[path] ?? null,
  };
};

describe("parsePomProject", () => {
  it("reads the project element through comments and the XML declaration", () => {
    const text = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<!-- a prose comment mentioning <dependencies> -->",
      "<project><artifactId>tool</artifactId></project>",
    ].join("\n");
    const parsed = parsePomProject(text);
    expect(parsed.reason).toBeUndefined();
    expect(parsed.project).toEqual(expect.objectContaining({ artifactId: "tool" }));
  });

  it("reports malformed XML as a reason, never a throw", () => {
    const result = parsePomProject("<project><unclosed>");
    expect(result.project).toBeUndefined();
    expect(result.reason).toContain("malformed");
  });

  it("reports XML with no project element by name", () => {
    const result = parsePomProject("<other>text</other>");
    expect(result.project).toBeUndefined();
    expect(result.reason).toContain("<project>");
  });
});

describe("pomEntryOf", () => {
  it("extracts coordinates, properties, and dependencies", () => {
    const text = [
      "<project>",
      "  <groupId>com.acme</groupId>",
      "  <artifactId>app</artifactId>",
      "  <version>${revision}</version>",
      "  <properties><pkg.group>com.acme</pkg.group></properties>",
      "  <dependencies>",
      "    <dependency><groupId>com.acme</groupId><artifactId>core</artifactId></dependency>",
      "    <dependency><groupId>org.lib</groupId><artifactId>ext</artifactId></dependency>",
      "  </dependencies>",
      "</project>",
    ].join("\n");
    const extracted = pomEntryOf("app", "app/pom.xml", text);
    expect(extracted.reason).toBeUndefined();
    const entry = extracted.entry;
    expect(entry.declaredGroupId).toBe("com.acme");
    expect(entry.artifactId).toBe("app");
    // The <version> element — even a CI-friendly ${revision} one — is read
    // for nothing: edges match group:artifact only.
    expect(entry.declaredDependencies).toEqual([
      { groupIdRaw: "com.acme", artifactIdRaw: "core" },
      { groupIdRaw: "org.lib", artifactIdRaw: "ext" },
    ]);
    expect(entry.ownProperties).toEqual({ "pkg.group": "com.acme" });
  });

  it("distinguishes an absent relativePath from `<relativePath/>`", () => {
    const withParent = pomEntryOf(
      "a",
      "a/pom.xml",
      "<project><parent><groupId>g</groupId><artifactId>p</artifactId></parent></project>",
    ).entry;
    if (withParent.parent) {
      expect(withParent.parent.explicitRemote).toBe(false);
      expect(withParent.parent.relativePath).toBeNull();
    }
    const remote = pomEntryOf(
      "a",
      "a/pom.xml",
      "<project><parent><groupId>g</groupId><artifactId>p</artifactId><relativePath/></parent></project>",
    ).entry;
    if (remote.parent) {
      expect(remote.parent.explicitRemote).toBe(true);
    }
  });

  it("keeps dependencies whose coordinates carry placeholders, uninterpolated", () => {
    const text =
      "<project><groupId>g</groupId><artifactId>a</artifactId>" +
      "<dependencies><dependency><groupId>${pkg.group}</groupId><artifactId>x</artifactId></dependency></dependencies>" +
      "</project>";
    const extracted = pomEntryOf("a", "a/pom.xml", text);
    expect(extracted.reason).toBeUndefined();
    expect(extracted.entry.declaredDependencies[0].groupIdRaw).toBe("${pkg.group}");
  });
});

describe("parentPomPath", () => {
  it("resolves both the file spelling and the directory spelling", () => {
    expect(parentPomPath("apps/app/pom.xml", "../pom.xml")).toBe("apps/pom.xml");
    expect(parentPomPath("apps/app/pom.xml", "../../parents/parent")).toBe(
      "parents/parent/pom.xml",
    );
  });

  it("returns null when the path escapes the workspace", () => {
    expect(parentPomPath("app/pom.xml", "../../../elsewhere")).toBeNull();
  });
});

describe("mavenConfigProperties", () => {
  it("reads -D definitions from every candidate that exists, later wins", () => {
    const props = mavenConfigProperties(
      (path) =>
        path === ".mvn/maven.config"
          ? "-Drevision=1.2.3\n-Dfeature=true\n"
          : path === "app/.mvn/maven.config"
            ? '"-Drevision=9.9.9"\n'
            : null,
      [".mvn/maven.config", "app/.mvn/maven.config"],
    );
    expect(props).toEqual({ revision: "9.9.9", feature: "true" });
  });

  it("answers {} when no config exists anywhere", () => {
    expect(mavenConfigProperties(() => null, ["a/.mvn/maven.config"])).toEqual({});
  });
});

describe("interpolateCoordinate", () => {
  it("resolves placeholders against props then builtins", () => {
    expect(interpolateCoordinate("${pkg}.${tail}", { pkg: "com", tail: "acme" }, {})).toEqual({
      value: "com.acme",
      resolved: true,
    });
    expect(interpolateCoordinate("${project.groupId}.x", {}, { "project.groupId": "g" })).toEqual({
      value: "g.x",
      resolved: true,
    });
  });

  it("leaves unknown placeholders visible and fails the coordinate", () => {
    expect(interpolateCoordinate("com.${who}", {}, {})).toEqual({
      value: "com.${who}",
      resolved: false,
    });
  });
});

describe("resolveMavenDependencies", () => {
  const reactor = () =>
    workspaceOf({
      "pom.xml": [
        "<project>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>acme-parent</artifactId>",
        "  <version>1.0.0</version>",
        "  <packaging>pom</packaging>",
        "  <properties><pkg.group>com.acme</pkg.group></properties>",
        "</project>",
      ].join("\n"),
      "core/pom.xml": [
        "<project>",
        "  <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId></parent>",
        "  <artifactId>core</artifactId>",
        "</project>",
      ].join("\n"),
      "app/pom.xml": [
        "<project>",
        "  <parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId></parent>",
        "  <artifactId>app</artifactId>",
        "  <dependencies>",
        "    <dependency><groupId>${pkg.group}</groupId><artifactId>core</artifactId></dependency>",
        "    <dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
    });

  it("draws sibling edges through inherited groupId and interpolated coords", () => {
    const ws = reactor();
    const edges = resolveMavenDependencies(ws.projects, ws.filesOf, ws.readFile);
    expect(edges).toEqual([
      { source: "app", target: "core", sourceFile: "app/pom.xml", type: "static" },
    ]);
    expect(mavenManifestFailures(ws)).toEqual([]);
  });

  it("counts the aggregator itself as a project others may declare", () => {
    const ws = reactor();
    const withChild = workspaceOf({
      ...{},
      "pom.xml": ws.readFile("pom.xml"),
      "core/pom.xml": ws.readFile("core/pom.xml"),
      "app/pom.xml": [
        "<project>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>app</artifactId>",
        "  <dependencies>",
        "    <dependency><groupId>com.acme</groupId><artifactId>acme-parent</artifactId></dependency>",
        "  </dependencies>",
        "</project>",
      ].join("\n"),
    });
    const edges = resolveMavenDependencies(
      withChild.projects,
      withChild.filesOf,
      withChild.readFile,
    );
    expect(edges).toEqual([
      { source: "app", target: "root", sourceFile: "app/pom.xml", type: "static" },
    ]);
  });

  it("fails loudly on a duplicate identity instead of picking a target", () => {
    const ws = workspaceOf({
      "a/pom.xml": "<project><groupId>com.acme</groupId><artifactId>twin</artifactId></project>",
      "b/pom.xml": "<project><groupId>com.acme</groupId><artifactId>twin</artifactId></project>",
      "c/pom.xml": [
        "<project>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>c</artifactId>",
        "  <dependencies><dependency><groupId>com.acme</groupId><artifactId>twin</artifactId></dependency></dependencies>",
        "</project>",
      ].join("\n"),
    });
    expect(resolveMavenDependencies(ws.projects, ws.filesOf, ws.readFile)).toEqual([]);
    const failures = mavenManifestFailures(ws);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("com.acme:twin");
    expect(failures[0].reason).toContain("a/pom.xml");
    expect(failures[0].reason).toContain("b/pom.xml");
  });

  it("records a remote parent loudly while outbound edges still draw", () => {
    const ws = workspaceOf({
      "app/pom.xml": [
        "<project>",
        "  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent>",
        "  <artifactId>app</artifactId>",
        "  <dependencies><dependency><groupId>com.sibling</groupId><artifactId>sib</artifactId></dependency></dependencies>",
        "</project>",
      ].join("\n"),
      "sib/pom.xml":
        "<project><groupId>com.sibling</groupId><artifactId>sib</artifactId></project>",
    });
    const edges = resolveMavenDependencies(ws.projects, ws.filesOf, ws.readFile);
    expect(edges).toEqual([
      { source: "app", target: "sib", sourceFile: "app/pom.xml", type: "static" },
    ]);
    const failures = mavenManifestFailures(ws);
    expect(failures.some((f) => f.reason.includes("spring-boot-starter-parent"))).toBe(true);
  });

  it("fails an unresolvable placeholder coordinate by name, never dropping silently", () => {
    const ws = workspaceOf({
      "app/pom.xml": [
        "<project>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>app</artifactId>",
        "  <dependencies><dependency><groupId>${missing.prop}</groupId><artifactId>x</artifactId></dependency></dependencies>",
        "</project>",
      ].join("\n"),
    });
    expect(resolveMavenDependencies(ws.projects, ws.filesOf, ws.readFile)).toEqual([]);
    const failures = mavenManifestFailures(ws);
    expect(failures.some((f) => f.reason.includes("${missing.prop}"))).toBe(true);
  });

  it("applies .mvn/maven.config user properties over pom properties", () => {
    const ws = workspaceOf({
      ".mvn/maven.config": "-Dpkg.group=com.config\n",
      "app/pom.xml": [
        "<project>",
        "  <groupId>com.acme</groupId>",
        "  <artifactId>app</artifactId>",
        "  <properties><pkg.group>com.pom</pkg.group></properties>",
        "  <dependencies><dependency><groupId>${pkg.group}</groupId><artifactId>dep</artifactId></dependency></dependencies>",
        "</project>",
      ].join("\n"),
      "dep/pom.xml": "<project><groupId>com.config</groupId><artifactId>dep</artifactId></project>",
    });
    const edges = resolveMavenDependencies(ws.projects, ws.filesOf, ws.readFile);
    expect(edges).toEqual([
      { source: "app", target: "dep", sourceFile: "app/pom.xml", type: "static" },
    ]);
  });

  it("fails malformed XML loudly rather than reading it as dependency-free", () => {
    const ws = workspaceOf({
      "broken/pom.xml": "<project><groupId>g<artifactId>a</project>",
      "ok/pom.xml": "<project><groupId>com.acme</groupId><artifactId>ok</artifactId></project>",
    });
    const failures = mavenManifestFailures(ws);
    expect(failures).toHaveLength(1);
    expect(failures[0].sourceFile).toBe("broken/pom.xml");
    expect(failures[0].reason).toContain("malformed");
  });

  it("detects a parent cycle instead of walking forever", () => {
    const ws = workspaceOf({
      "a/pom.xml": [
        "<project>",
        "  <parent><groupId>com.acme</groupId><artifactId>b</artifactId><relativePath>../b/pom.xml</relativePath></parent>",
        "  <artifactId>a</artifactId>",
        "</project>",
      ].join("\n"),
      "b/pom.xml": [
        "<project>",
        "  <parent><groupId>com.acme</groupId><artifactId>a</artifactId><relativePath>../a/pom.xml</relativePath></parent>",
        "  <artifactId>b</artifactId>",
        "</project>",
      ].join("\n"),
    });
    const failures = mavenManifestFailures(ws);
    expect(failures.some((failure) => failure.reason.includes("cycle"))).toBe(true);
  });

  it("inherits groupId through a GRANDparent chain, not only the immediate parent", () => {
    const ws = workspaceOf({
      "grandparent/pom.xml":
        "<project><groupId>com.root</groupId><artifactId>gp</artifactId><packaging>pom</packaging></project>",
      "mid/pom.xml": [
        "<project>",
        "  <parent><groupId>com.root</groupId><artifactId>gp</artifactId><relativePath>../grandparent</relativePath></parent>",
        "  <artifactId>mid</artifactId>",
        "  <packaging>pom</packaging>",
        "  <properties><layer>mid</layer></properties>",
        "</project>",
      ].join("\n"),
      "leaf/pom.xml": [
        "<project>",
        "  <parent><groupId>com.root</groupId><artifactId>mid</artifactId><relativePath>../mid</relativePath></parent>",
        "  <artifactId>leaf</artifactId>",
        "</project>",
      ].join("\n"),
    });
    const model = mavenModelOf(ws);
    const leaf = model.entries.find((entry) => entry.pomPath === "leaf/pom.xml");
    expect(leaf.effectiveGroupId).toBe("com.root");
    expect(leaf.properties.layer).toBe("mid");
    expect(model.failures).toEqual([]);
  });
});
