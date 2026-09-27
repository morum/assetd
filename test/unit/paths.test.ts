import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extensionOf,
  isWithinLogical,
  normalizeLogicalInput,
  pathMatchKey,
  pathTokens,
  toLogicalPath,
  toNativePath,
} from "../../src/core/paths.ts";

describe("logical paths on Windows", () => {
  const w = path.win32;
  it("converts native paths to forward-slash logical paths", () => {
    expect(toLogicalPath("C:\\games\\proj", "C:\\games\\proj\\assets\\props\\chest.png", w)).toBe("assets/props/chest.png");
  });
  it("is case-insensitive about the root, like the filesystem", () => {
    expect(toLogicalPath("C:\\Games\\Proj", "c:\\games\\proj\\Assets\\Chest.png", w)).toBe("Assets/Chest.png");
  });
  it("rejects paths on another drive", () => {
    expect(toLogicalPath("C:\\proj", "D:\\proj\\a.png", w)).toBeNull();
  });
  it("rejects paths outside the root", () => {
    expect(toLogicalPath("C:\\proj", "C:\\other\\a.png", w)).toBeNull();
  });
  it("handles spaces and unicode", () => {
    expect(toLogicalPath("C:\\my proj", "C:\\my proj\\ícones\\poção de vida.png", w)).toBe("ícones/poção de vida.png");
  });
  it("round-trips to native paths", () => {
    expect(toNativePath("C:\\proj", "assets/ui/a b.png", w)).toBe("C:\\proj\\assets\\ui\\a b.png");
  });
  it("supports UNC roots", () => {
    expect(toLogicalPath("\\\\server\\share\\proj", "\\\\server\\share\\proj\\a\\b.png", w)).toBe("a/b.png");
  });
});

describe("logical paths on Linux", () => {
  const p = path.posix;
  it("converts native paths", () => {
    expect(toLogicalPath("/home/u/proj", "/home/u/proj/assets/a.png", p)).toBe("assets/a.png");
  });
  it("is case-sensitive about the root", () => {
    expect(toLogicalPath("/home/u/Proj", "/home/u/proj/a.png", p)).toBeNull();
  });
  it("returns the empty string for the root itself", () => {
    expect(toLogicalPath("/proj", "/proj", p)).toBe("");
  });
  it("does not confuse sibling prefixes", () => {
    expect(toLogicalPath("/proj", "/project/a.png", p)).toBeNull();
  });
  it("round-trips", () => {
    expect(toNativePath("/proj", "a/b c/d.png", p)).toBe("/proj/a/b c/d.png");
  });
});

describe("normalizeLogicalInput", () => {
  it("accepts either separator and strips ./", () => {
    expect(normalizeLogicalInput(".\\assets\\ui\\icon.png")).toBe("assets/ui/icon.png");
    expect(normalizeLogicalInput("./assets//ui/./icon.png")).toBe("assets/ui/icon.png");
  });
  it("resolves inner .. but refuses to escape", () => {
    expect(normalizeLogicalInput("assets/x/../y.png")).toBe("assets/y.png");
    expect(normalizeLogicalInput("../y.png")).toBeNull();
  });
  it("refuses absolute paths", () => {
    expect(normalizeLogicalInput("/etc/passwd")).toBeNull();
    expect(normalizeLogicalInput("C:\\x.png")).toBeNull();
    expect(normalizeLogicalInput("c:/x.png")).toBeNull();
  });
});

describe("helpers", () => {
  it("match keys fold case and Unicode normalization", () => {
    const nfd = "poc\u0327a\u0303o.png"; // decomposed
    expect(pathMatchKey(nfd)).toBe(pathMatchKey("POÇÃO.PNG"));
  });
  it("extensions are lower-case", () => {
    expect(extensionOf("a/B.PNG")).toBe("png");
    expect(extensionOf("a/.hidden")).toBe("");
    expect(extensionOf("a.b/c")).toBe("");
  });
  it("isWithinLogical respects segment boundaries", () => {
    expect(isWithinLogical("assets", "assets/a.png")).toBe(true);
    expect(isWithinLogical("assets", "assets2/a.png")).toBe(false);
    expect(isWithinLogical("", "x.png")).toBe(true);
  });
  it("tokenizes paths including camelCase and separators", () => {
    expect(pathTokens("assets/ui/swordIcon_dark-01.png")).toEqual(["assets", "ui", "sword", "icon", "dark", "01"]);
  });
});
