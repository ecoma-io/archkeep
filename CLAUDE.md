@AGENTS.md

<!--
This file carries no guidance of its own — AGENTS.md does, and the import above
is the whole content. It is a regular file rather than a symlink to that file on
purpose: Git only reproduces a symlink on Windows when `core.symlinks` is on,
which needs Developer Mode or an elevated clone. Where it is off, Git writes a
one-line text file containing the path instead, so a Windows contributor would
get the literal string `AGENTS.md` and no guidance at all — silently, since
nothing errors. The `@` import resolves the same way on every platform.
-->
