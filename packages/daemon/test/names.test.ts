import { describe, expect, it } from "vitest";
import { NAMESPACE_SEPARATOR, namespaceToolName, splitToolName } from "@webmcp/protocol";

describe("tool namespacing", () => {
  it("round-trips a downstream name", () => {
    const name = namespaceToolName("notion", "search");
    expect(name).toBe(`notion${NAMESPACE_SEPARATOR}search`);
    expect(splitToolName(name)).toEqual({ server: "notion", tool: "search" });
  });

  it("treats an un-namespaced name as a built-in", () => {
    expect(splitToolName("fs_read")).toEqual({ server: null, tool: "fs_read" });
  });

  it("splits on the first separator only, so a downstream name may contain one", () => {
    // A server that names its own tools `get__page` must still route correctly.
    expect(splitToolName("figma__get__page")).toEqual({ server: "figma", tool: "get__page" });
  });

  it("keeps two servers from colliding", () => {
    const a = namespaceToolName("notion", "search");
    const b = namespaceToolName("figma", "search");
    expect(a).not.toBe(b);
    expect(splitToolName(a).server).toBe("notion");
    expect(splitToolName(b).server).toBe("figma");
  });

  it("does not read a leading separator as an empty server name", () => {
    expect(splitToolName("__weird")).toEqual({ server: null, tool: "__weird" });
  });
});
