# Gate scripts (`scripts/**`)

These scripts are what makes a green build mean something. Judge them as
enforcement, not tooling:

- **Facts enter as arguments.** A gate that reads a file and decides in the
  same body cannot be tested without stubbing the answer — the split is the
  improvement, and a test that stubbed the answer would pin the stub. Only
  the outermost read touches the outside world, and it is deliberately
  untested.
- **No second copy of a CI-owned truth.** A constant restating what a
  workflow or a manifest already declares agrees with it only until someone
  edits one of them — the drift the gate exists to catch must not have an
  instance inside the gate. Derive, or name the derivation in the header.
- **Every early exit is loud.** A `return` on a condition that should have
  been reported, and a loop accumulating failures into an array nobody
  checks, both look like success to CI.
- **Tests run with no filesystem and no mocking.** The pure half gets the
  test; a partial set is an expected answer, not a finding, and an empty
  verdict is a claim the test must force the gate to make honestly.
