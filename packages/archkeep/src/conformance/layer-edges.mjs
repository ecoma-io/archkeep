/**
 * The masked static-import-edge extractor the layer-direction scans share.
 *
 * `layer-direction.test.mjs` (#649, `src/lsp` → `src/commands`) grew it
 * inline; the G-1/G-5/G-2 gates (`layer-direction-imports.test.mjs`)
 * need the identical judgment, and a judgment duplicated is
 * a judgment that drifts — so the regex array and the extraction function
 * live here, moved whole from the #649 gate, and both scans import them.
 * Nothing here decides anything: it reports the relative specifiers a
 * module's code (never its prose) statically names, and each scan decides
 * which targets are banned.
 */

import { maskNonCode } from "../intent/mask-non-code.mjs";

/**
 * Static import/export-from spellings, one regex per shape, specifier in
 * group 1. Line-unanchored on purpose: an import statement spans lines in
 * this tree, and a line-anchored scanner would drop that edge in the silent
 * direction.
 *
 * @type {RegExp[]}
 */
const STATIC_IMPORT_PATTERNS = [
  /\bimport\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*\*\s*as\s+[\w$]+\s*from\s*["']([^"']+)["']/g,
  /\bimport\s+[\w$]+\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+\}))?\s*from\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g,
  /\bexport\s*\*\s*from\s*["']([^"']+)["']/g,
];

/**
 * The relative specifiers one module statically imports, comments, strings,
 * template literals and regex literals excluded: a match survives only where
 * `maskNonCode` still shows the source character at the match's own offset.
 *
 * @param {string} raw Module source text.
 * @returns {string[]} Relative specifiers, in source order.
 */
export function staticRelativeSpecifiers(raw) {
  const masked = maskNonCode(raw);
  const found = [];
  for (const pattern of STATIC_IMPORT_PATTERNS) {
    for (const match of raw.matchAll(pattern)) {
      if (masked[match.index] !== raw[match.index]) continue;
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      found.push(specifier);
    }
  }
  return found;
}
