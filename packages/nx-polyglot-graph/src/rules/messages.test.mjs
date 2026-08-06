import { describe, expect, it } from "vitest";

import { MESSAGE_IDS, MESSAGES, renderMessage } from "./messages.mjs";

describe("renderMessage", () => {
  it("fills every placeholder from the data it is given", () => {
    expect(
      renderMessage("onlyTagsConstraintViolation", { sourceTag: "zone:x", tags: '"zone:y"' }),
    ).toBe('A project tagged with "zone:x" can only depend on libs tagged with "zone:y"');
  });

  it("tolerates whitespace inside a placeholder", () => {
    expect(renderMessage("noSelfCircularDependencies", { imp: "@scope/self" })).toContain(
      '"@scope/self"',
    );
    expect(MESSAGES.noSelfCircularDependencies).toContain("{{imp}}");
  });

  // Blanking it would read as a rule that found nothing to say; leaving it
  // visible says the rule forgot to pass data, which is the true statement.
  it("leaves a placeholder standing when no value was passed for it", () => {
    expect(renderMessage("emptyOnlyTagsConstraintViolation")).toContain("{{sourceTag}}");
  });

  it("refuses an id that is not one upstream defines", () => {
    expect(() => renderMessage("noImportsOfAppsPlease")).toThrow(/no message template/);
  });

  it("lists exactly the ids it can render", () => {
    expect(MESSAGE_IDS).toHaveLength(15);
    expect(MESSAGE_IDS.every((id) => typeof MESSAGES[id] === "string")).toBe(true);
  });
});
