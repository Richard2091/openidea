import { describe, expect, it } from "vitest";
import { terminalKeyAction } from "./keys";
import { matchCounter } from "./FindBar";
import { buildSearchDecorations } from "./theme";
import { findTerminalLinks, resolvePath, trimUrl } from "./links";
import { layoutPanes, nextTabName, removeFromLayout, splitLayout } from "./store";
import { buildTheme, mix, parseColor, toHex, withFontExtras } from "./theme";

describe("theme", () => {
  it("parses colour formats", () => {
    expect(parseColor("#0f1012")).toEqual([15, 16, 18, 1]);
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("#00000080")?.[3]).toBeCloseTo(0.5, 2);
    expect(parseColor("rgb(1, 2, 3)")).toEqual([1, 2, 3, 1]);
    expect(parseColor("rgba(1 2 3 / 50%)")).toEqual([1, 2, 3, 0.5]);
    expect(parseColor("color(srgb 1 0 0.5)")).toEqual([255, 0, 127.5, 1]);
    expect(parseColor("var(--x)")).toBeNull();
  });

  it("mixes and formats", () => {
    expect(toHex(mix([0, 0, 0, 1], [255, 255, 255, 1], 0.5))).toBe("#808080");
  });

  it("derives a full palette from tokens", () => {
    const tokens: Record<string, string> = {
      "--bg-app": "#0f1012",
      "--fg": "#b9bbc1",
      "--fg-strong": "#e2e3e6",
      "--accent": "#8fa5d6",
      "--danger": "#c97a6f",
      "--success": "#8fae7e",
      "--warning": "#c9a35f",
      "--syn-keyword": "#8fa5d6",
      "--syn-annotation": "#a89bc4",
      "--syn-string": "#9fb88a",
      "--fg-subtle": "#6d7076",
      "--control-off": "#3a3b3f",
    };
    const theme = buildTheme((n) => tokens[n] ?? "");
    expect(theme.background).toBe("#0f1012");
    expect(theme.foreground).toBe("#b9bbc1");
    expect(theme.cursor).toBe("#8fa5d6");
    expect(theme.red).toBe("#c97a6f");
    expect(theme.brightWhite).toBe("#e2e3e6");
    for (const key of ["black", "cyan", "brightRed", "brightCyan", "selectionBackground"] as const) {
      expect(theme[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(theme.brightRed).not.toBe(theme.red);
  });

  it("falls back when tokens are missing", () => {
    const theme = buildTheme(() => "");
    expect(theme.background).toBe("#0f1012");
    expect(theme.red).toMatch(/^#/);
  });
});

describe("terminal links", () => {
  it("finds URLs and file locations", () => {
    const links = findTerminalLinks("see https://example.com/x). error at src/main.rs:10:5 and ./a/b.ts:3");
    expect(links.map((l) => l.text)).toEqual(["https://example.com/x", "src/main.rs:10:5", "./a/b.ts:3"]);
    const file = links[1]!;
    expect(file.kind === "file" && [file.path, file.line, file.col]).toEqual(["src/main.rs", 10, 5]);
  });

  it("supports paren locations and absolute paths", () => {
    const [l] = findTerminalLinks("/Users/me/p/App.tsx(14,3): error");
    expect(l?.kind === "file" && [l.path, l.line, l.col]).toEqual(["/Users/me/p/App.tsx", 14, 3]);
  });

  it("ignores plain numbers and URL ports", () => {
    expect(findTerminalLinks("12:30 http://localhost:3000").map((l) => l.kind)).toEqual(["url"]);
  });

  it("trims trailing punctuation from URLs", () => {
    expect(trimUrl("https://a.dev/x.")).toBe("https://a.dev/x");
    expect(trimUrl("https://a.dev/(x)")).toBe("https://a.dev/(x)");
    expect(trimUrl("https://a.dev/x)")).toBe("https://a.dev/x");
  });

  it("resolves paths against the cwd", () => {
    expect(resolvePath("src/a.ts", "/p")).toBe("/p/src/a.ts");
    expect(resolvePath("../b.ts", "/p/web")).toBe("/p/b.ts");
    expect(resolvePath("/abs/c.ts", "/p")).toBe("/abs/c.ts");
    expect(resolvePath("~/d.ts", "/p", "/Users/me")).toBe("/Users/me/d.ts");
  });
});

describe("terminal keys", () => {
  const key = (k: Partial<KeyboardEvent>) =>
    ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k }) as KeyboardEvent;

  it("sends Ctrl+letter to the shell instead of IDE shortcuts", () => {
    expect(terminalKeyAction(key({ key: "r", code: "KeyR", ctrlKey: true }), false)).toEqual({
      kind: "send",
      data: "\x12",
    });
    expect(terminalKeyAction(key({ key: "d", code: "KeyD", ctrlKey: true }), false)).toEqual({
      kind: "send",
      data: "\x04",
    });
    expect(terminalKeyAction(key({ key: "c", code: "KeyC", ctrlKey: true }), true)).toEqual({
      kind: "send",
      data: "\x03",
    });
    expect(terminalKeyAction(key({ key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }), true)).toEqual({
      kind: "copy",
    });
    expect(terminalKeyAction(key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "paste",
    });
    // Ctrl+Shift+T is New Tab in the IDE keymap; Ctrl+T still goes to the shell.
    expect(terminalKeyAction(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), false)).toEqual({
      kind: "pass",
    });
    expect(terminalKeyAction(key({ key: "t", code: "KeyT", ctrlKey: true }), false)).toEqual({ kind: "send", data: "\x14" });
  });

  it("implements macOS conveniences", () => {
    expect(terminalKeyAction(key({ key: "c", metaKey: true }), true)).toEqual({ kind: "copy" });
    expect(terminalKeyAction(key({ key: "c", metaKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "k", metaKey: true }), false)).toEqual({ kind: "clear" });
    expect(terminalKeyAction(key({ key: "t", metaKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "v", metaKey: true }), false)).toEqual({ kind: "paste" });
    expect(terminalKeyAction(key({ key: "f", metaKey: true }), false)).toEqual({ kind: "find" });
    expect(terminalKeyAction(key({ key: "ArrowLeft", altKey: true }), false)).toEqual({ kind: "send", data: "\x1bb" });
    expect(terminalKeyAction(key({ key: "Escape" }), false)).toEqual({ kind: "send", data: "\x1b" });
  });

  it("leaves other IDE shortcuts alone", () => {
    expect(terminalKeyAction(key({ key: "F12", altKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "1", metaKey: true }), false)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(key({ key: "a" }), false)).toEqual({ kind: "pass" });
  });
});

describe("tab names", () => {
  it("numbers duplicates like IDEA", () => {
    expect(nextTabName([])).toBe("Local");
    expect(nextTabName(["Local"])).toBe("Local (2)");
    expect(nextTabName(["Local", "Local (2)"])).toBe("Local (3)");
    expect(nextTabName(["Local"], "api")).toBe("api");
  });
});

describe("terminal find", () => {
  it("formats the match counter", () => {
    expect(matchCounter(null, "x")).toBe("");
    expect(matchCounter({ index: 2, count: 12 }, "x")).toBe("3/12");
    expect(matchCounter({ index: -1, count: 2000 }, "x")).toBe("2000+");
    expect(matchCounter({ index: -1, count: 0 }, "x")).toBe("0 results");
    expect(matchCounter({ index: 0, count: 3 }, "")).toBe("");
  });

  it("builds #rrggbb search decorations from tokens", () => {
    const d = buildSearchDecorations((n) => (n === "--match" ? "#8fa5d6" : n === "--bg-app" ? "#000000" : ""));
    for (const v of Object.values(d)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(d.matchOverviewRuler).toBe("#8fa5d6");
  });
});

describe("split layout", () => {
  it("nests a split when the orientation changes", () => {
    let l = splitLayout("a", "a", "b", "vertical", "g1");
    expect(l).toEqual({ id: "g1", orientation: "vertical", children: ["a", "b"] });
    l = splitLayout(l, "b", "c", "horizontal", "g2");
    expect(l).toEqual({
      id: "g1",
      orientation: "vertical",
      children: ["a", { id: "g2", orientation: "horizontal", children: ["b", "c"] }],
    });
    l = splitLayout(l, "a", "d", "vertical", "g3");
    expect(layoutPanes(l)).toEqual(["a", "d", "b", "c"]);
  });

  it("collapses single-child splits on removal", () => {
    const l = splitLayout(splitLayout("a", "a", "b", "vertical", "g1"), "b", "c", "horizontal", "g2");
    expect(removeFromLayout(l, "a")).toEqual({ id: "g2", orientation: "horizontal", children: ["b", "c"] });
    expect(removeFromLayout(l, "c")).toEqual({ id: "g1", orientation: "vertical", children: ["a", "b"] });
    expect(removeFromLayout("a", "a")).toBeNull();
  });
});

describe("withFontExtras", () => {
  const font = { family: '"JetBrains Mono", "Symbols Nerd Font", monospace', size: 10, lineHeight: 1 };

  it("puts the fallback family right after the main one", () => {
    expect(withFontExtras(font, { fallbackFontFamily: "PingFang SC", columnWidth: 1 }).family).toBe(
      '"JetBrains Mono", "PingFang SC", "Symbols Nerd Font", monospace',
    );
    expect(withFontExtras(font, { fallbackFontFamily: "", columnWidth: 1 }).family).toBe(font.family);
  });

  it("turns the column width into letter spacing", () => {
    expect(withFontExtras(font, { fallbackFontFamily: "", columnWidth: 1 }).letterSpacing).toBe(0);
    expect(withFontExtras(font, { fallbackFontFamily: "", columnWidth: 1.5 }).letterSpacing).toBe(3);
  });
});
