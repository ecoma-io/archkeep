/**
 * The terminal report for the `waivers` command.
 *
 * Each waiver row is its path (what it accepts), the term, and the current
 * coverage — so a cell that reads "covers nothing" is a row whose reason has
 * lapsed, surfaced loudly rather than tucked away. Each permanent-suppression
 * row is the same shape minus the term, since it has none — a suppression
 * accepts forever, so "currently hides N violations" is the only fact that
 * can change about it. The summary states the counts so "no waivers" never
 * collapses into "every boundary is enforced" while a permanent suppression
 * on the table is doing exactly that, unmeasured — see this module's header.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`./README.md`).
 */

/**
 * @param {{waivers: object[], covered: number, expired: number, stale: number,
 *   suppressions: object[], suppressed: number}} result
 * @returns {string}
 */
export function formatWaiversReport({
  waivers,
  covered,
  expired,
  stale,
  suppressions,
  suppressed,
}) {
  const sections = [];

  if (waivers.length === 0 && suppressions.length === 0) {
    return `no waivers — every boundary is enforced, nothing is being accepted temporarily or permanently`;
  }

  if (waivers.length === 0) {
    // The claim this branch must NOT make: "every boundary is enforced" —
    // the permanent-suppressions section below is about to name at least one
    // row this run measured and found accepting a violation forever.
    sections.push(`no waivers — nothing is being accepted temporarily`);
  } else {
    sections.push(
      `${waivers.length} waiver${waivers.length === 1 ? "" : "s"} on the table — ` +
        `${covered} currently cover${covered === 1 ? "s" : ""} a violation, ` +
        `${expired} expired, ${stale} cover${stale === 1 ? "s" : ""} nothing right now`,
    );

    for (const waiver of waivers) {
      const messageId = waiver.messageId ? ` (${waiver.messageId})` : "";
      const remaining =
        waiver.status === "expired"
          ? `expired ${Math.abs(waiver.remainingMs)}ms ago`
          : `${Math.floor(waiver.remainingMs / 86_400_000)}d ` +
            `${Math.floor((waiver.remainingMs % 86_400_000) / 3_600_000)}h left`;
      const coverage =
        waiver.covered === 0
          ? "covers nothing right now — the violation it accepted may be fixed"
          : `${waiver.covered} current violation${waiver.covered === 1 ? "" : "s"}`;
      const lines = [
        `- ${waiver.path}${messageId}: ${coverage}`,
        `  reason: ${waiver.reason}`,
        `  expires: ${waiver.expiresAt} (${remaining})`,
      ];
      if (waiver.origin) lines.push(`  origin: ${waiver.origin}`);
      sections.push(lines.join("\n"));
    }

    if (stale > 0) {
      sections.push(
        `⚠ ${stale} waiver${stale === 1 ? "" : "s"} cover${stale === 1 ? "s" : ""} no violation ` +
          `right now — consider removing it. Waivers are never silently deleted, they are ` +
          `removed by an explicit edit; a row that covers nothing is dead weight.`,
      );
    }
  }

  if (suppressions.length > 0) {
    sections.push(
      `${suppressions.length} permanent suppression${suppressions.length === 1 ? "" : "s"} on the ` +
        `table — no expiry, no re-assertion — currently hiding ${suppressed} violation` +
        `${suppressed === 1 ? "" : "s"} that would otherwise be reported`,
    );

    for (const suppression of suppressions) {
      const messageId = suppression.messageId ? ` (${suppression.messageId})` : "";
      const coverage =
        suppression.covered === 0
          ? "covers nothing right now"
          : `permanently hides ${suppression.covered} current violation${suppression.covered === 1 ? "" : "s"}`;
      const lines = [
        `- ${suppression.path}${messageId}: ${coverage}`,
        `  reason: ${suppression.reason}`,
      ];
      if (suppression.origin) lines.push(`  origin: ${suppression.origin}`);
      sections.push(lines.join("\n"));
    }
  }

  return sections.join("\n\n");
}
