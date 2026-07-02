import { describe, expect, test } from "bun:test";
import {
  scoreAndSort,
  scoreItem,
  type FuzzyItem,
  type MatchRange,
} from "./fuzzy.ts";

function scoreOf(query: string, item: FuzzyItem): number {
  const res = scoreItem(query, item);
  return res ? res.score : -Infinity;
}

describe("scoreItem — subsequence matching", () => {
  test("returns null when query is not a subsequence of label or description", () => {
    expect(scoreItem("xyz", { label: "Document.ts" })).toBeNull();
    expect(
      scoreItem("zzz", { label: "Document.ts", description: "src/docs/x.ts" }),
    ).toBeNull();
  });

  test("case-insensitive subsequence match", () => {
    expect(scoreItem("DOC", { label: "document.ts" })).not.toBeNull();
    expect(scoreItem("doc", { label: "DOCUMENT.TS" })).not.toBeNull();
  });

  test("empty query returns null", () => {
    expect(scoreItem("", { label: "anything" })).toBeNull();
  });
});

describe("scoreItem — tiered ranking", () => {
  test("exact label match outranks prefix match", () => {
    expect(scoreOf("readme", { label: "readme" })).toBeGreaterThan(
      scoreOf("readme", { label: "readme.md" }),
    );
  });

  test("prefix match outranks a contains match", () => {
    expect(scoreOf("doc", { label: "Document.ts" })).toBeGreaterThan(
      scoreOf("doc", { label: "myDocument.ts" }),
    );
  });

  test("contains match outranks a description-only match", () => {
    const contains = scoreOf("doc", { label: "myDocument.ts" });
    const descOnly = scoreOf("doc", {
      label: "index.ts",
      description: "src/docs/x.ts",
    });
    expect(contains).toBeGreaterThan(descOnly);
  });

  test("ANY label match outranks ANY description-only match", () => {
    // Worst-case label match (scattered contains) vs best-case description match.
    const worstLabel = scoreOf("abc", { label: "aXbXc" });
    const bestDesc = scoreOf("abc", {
      label: "nope.ts",
      description: "abc",
    });
    expect(worstLabel).toBeGreaterThan(bestDesc);
  });

  test('query "doc": label "Document.ts" ranks above path-only "src/docs/x.ts"', () => {
    const items = [
      { label: "index.ts", description: "src/docs/x.ts" },
      { label: "Document.ts", description: "src/model/Document.ts" },
    ];
    const ranked = scoreAndSort("doc", items, (i) => i);
    expect(ranked[0]!.item.label).toBe("Document.ts");
    expect(ranked[1]!.item.label).toBe("index.ts");
  });
});

describe("scoreItem — camelCase / separator bonuses", () => {
  test('"usrctl" matches "userController.ts" via camelCase boundaries', () => {
    const res = scoreItem("usrctl", { label: "userController.ts" });
    expect(res).not.toBeNull();
    // u s r of "user", C of "Controller", t l of "controller"
    // The C is a camelCase boundary and should be part of the match.
    const matched = res!.labelMatches;
    const flat = new Set<number>();
    for (const [s, e] of matched) for (let i = s; i < e; i++) flat.add(i);
    expect(flat.has("userController.ts".indexOf("C"))).toBe(true);
  });

  test('"wsvc" matches "workspace.service.ts"', () => {
    const res = scoreItem("wsvc", { label: "workspace.service.ts" });
    expect(res).not.toBeNull();
  });

  test("camelCase match scores higher than the same chars mid-word", () => {
    // "gp" against "getParser" (camelCase boundary at P) vs "grouping" (mid-word p)
    const camel = scoreOf("gp", { label: "getParser" });
    const midWord = scoreOf("gp", { label: "grouping" });
    expect(camel).toBeGreaterThan(midWord);
  });
});

describe("scoreItem — consecutive-run bonus", () => {
  test("one long consecutive run scores higher than scattered same chars", () => {
    // Both are 'contains' tier (leading 'x' prevents prefix match).
    const consecutive = scoreOf("abc", { label: "xabc" });
    const scattered = scoreOf("abc", { label: "xaxbxc" });
    expect(consecutive).toBeGreaterThan(scattered);
  });

  test("an isolated (scattered) match earns no consecutive bonus", () => {
    // A fully scattered match should score no run bonus at all, so it loses to
    // any partially-consecutive arrangement of the same characters.
    const consecutive = scoreOf("abc", { label: "zabxc" }); // 'ab' run
    const scattered = scoreOf("abc", { label: "zaxbxc" }); // all isolated
    expect(consecutive).toBeGreaterThan(scattered);
  });
});

describe("scoreItem — match ranges", () => {
  test("adjacent matched indices merge into a single [start,end) range", () => {
    const res = scoreItem("abc", { label: "xabc" });
    expect(res).not.toBeNull();
    const ranges: MatchRange[] = res!.labelMatches;
    expect(ranges).toEqual([[1, 4]]);
  });

  test("non-adjacent matches produce separate ranges", () => {
    const res = scoreItem("ac", { label: "abc" });
    expect(res).not.toBeNull();
    expect(res!.labelMatches).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  test("description-only match populates descriptionMatches, not labelMatches", () => {
    const res = scoreItem("doc", {
      label: "index.ts",
      description: "src/docs/x.ts",
    });
    expect(res).not.toBeNull();
    expect(res!.labelMatches).toEqual([]);
    expect(res!.descriptionMatches.length).toBeGreaterThan(0);
  });

  test("prefix match ranges cover the query span", () => {
    const res = scoreItem("doc", { label: "Document.ts" });
    expect(res).not.toBeNull();
    expect(res!.labelMatches).toEqual([[0, 3]]);
  });
});

describe("scoreAndSort", () => {
  test("filters out non-matches and sorts descending by score", () => {
    const items = [
      { label: "notmatching.ts" },
      { label: "Document.ts" },
      { label: "myDocument.ts" },
      { label: "readme.md", description: "docs/readme.md" },
    ];
    const ranked = scoreAndSort("doc", items, (i) => i);
    const labels = ranked.map((r) => r.item.label);
    expect(labels).not.toContain("notmatching.ts");
    // Document.ts (prefix) > myDocument.ts (contains) > readme.md (desc-only)
    expect(labels).toEqual(["Document.ts", "myDocument.ts", "readme.md"]);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  test("empty query returns all items unranked in original order", () => {
    const items = [{ label: "b" }, { label: "a" }, { label: "c" }];
    const ranked = scoreAndSort("", items, (i) => i);
    expect(ranked.map((r) => r.item.label)).toEqual(["b", "a", "c"]);
    for (const r of ranked) {
      expect(r.score).toBe(0);
      expect(r.labelMatches).toEqual([]);
      expect(r.descriptionMatches).toEqual([]);
    }
  });

  test("carries through the original item reference", () => {
    const items = [{ id: 1, label: "alpha" }, { id: 2, label: "beta" }];
    const ranked = scoreAndSort("al", items, (i) => ({ label: i.label }));
    expect(ranked[0]!.item.id).toBe(1);
  });
});

describe("performance", () => {
  test("scoreAndSort over 10k items completes well under 200ms", () => {
    const words = ["user", "workspace", "service", "document", "controller"];
    const items: FuzzyItem[] = [];
    for (let i = 0; i < 10_000; i++) {
      const a = words[i % words.length]!;
      const b = words[(i * 7) % words.length]!;
      items.push({
        label: `${a}${b[0]!.toUpperCase()}${b.slice(1)}${i}.ts`,
        description: `src/${a}/${b}/file${i}.ts`,
      });
    }
    const start = Date.now();
    const ranked = scoreAndSort("srvc", items, (i) => i);
    const elapsed = Date.now() - start;
    expect(ranked.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(200);
  });
});
