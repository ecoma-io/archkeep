/**
 * The terminal report for the `waivers` command.
 *
 * Each row is the waiver's path (what it accepts), the term, and the current
 * coverage — so a cell that reads "covers nothing" is a row whose reason has
 * lapsed, surfaced loudly rather than tucked away. The summary states the
 * counts so "no waivers" always reads as a claim about a specific, complete
 * surface.
 *
 * This module decides nothing. A formatter that filtered would be a rule
 * wearing a formatter's name (`./README.md`).
 */

/**
 * @param {{waivers: object[], covered: number, expired: number, stale: number}} result
 * @returns {string}
 */
export function formatWaiversReport({ waivers, covered, expired, stale }) {
  const sections = [];
  if (waivers.length === 0) {
    return `no waivers — every boundary is enforced, nothing is being accepted temporarily`;
  }

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
  return sections.join("\n\n");
}
