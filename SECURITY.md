# Security Policy

## Supported versions

This project is pre-release. Security fixes are applied to the `main` branch
and released in the next version. There is no long-term support branch.

## Reporting a vulnerability

**Do not open a public issue.** A public disclosure gives attackers a head start
before a fix is available.

Email **john.itvn@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce it, or a proof-of-concept
- Your assessment of the impact

You will receive an acknowledgement within 48 hours. If you have not heard back
in that time, follow up by email.

## What counts as a vulnerability here

The threat surface of this project is narrow but specific:

**A gate or plugin that reports nothing when it should report something** is the
most dangerous class of defect this project has. If you find a way to make the
graph reader or the boundary rules produce an empty result when a real violation
exists — by supplying a crafted manifest, a specially named directory, or any
other input the package tree accepts — that is a security-relevant false negative,
not an ordinary bug. Please report it through this channel rather than as a
public issue.

**Values from the package tree reach child processes.** Directory names, manifest
fields, and project names in `packages/` come from whoever opens a pull request.
If you find a path where one of those values reaches a shell command in a way the
Semgrep rules in `.github/semgrep/scripts.yaml` do not catch, that is a
command-injection vulnerability.

**GitHub Actions supply-chain.** The `analysis.yml` workflow pins actions to
full commit SHAs and the Semgrep image to a digest. If you find a path where an
unpinned reference exists and could be substituted, report it here.

**A custom-rule artifact is untrusted bytes the policy names.** A declared
`customRules` row runs a WebAssembly module inside the checker. The contract
refuses ambient capability — a module declaring any import is rejected at
load, and the host grants no filesystem, network, or clock — verifies the
row's declared sha256 against the artifact's actual bytes, and bounds
execution time, memory, and verdict size
(`docs/reference/custom-rules.md`). If you find a way for a rule module to
reach outside that sandbox, to run under a hash that does not match its
bytes, to exhaust the host past its stated bounds, or to make a declared
rule silently not run at all, that is a security-relevant defect of the
same class as the false negative above — report it through this channel.

Everything else — a wrong message, a missed configuration option, a UI defect in
the VS Code extension — is an ordinary bug and can go in the public issue tracker.

## Disclosure timeline

We aim to publish a fix within 14 days of a confirmed report. We will coordinate
the disclosure date with you. If we cannot meet 14 days for reasons outside our
control, we will tell you.

We will credit you in the release notes unless you prefer to remain anonymous.
