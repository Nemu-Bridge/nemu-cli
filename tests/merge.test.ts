import { describe, expect, test } from "bun:test";
import { has_conflict_markers, matching_lines, merge_text } from "../src/vault/merge.js";

function clean(base: string, local: string, remote: string): string {
  const result = merge_text(base, local, remote);
  if (result.kind !== "clean") throw new Error("expected a clean merge");
  return result.text;
}

describe("three-way merge", () => {
  test("identical sides merge to that text", () => {
    expect(clean("a\n", "b\n", "b\n")).toBe("b\n");
  });

  test("only one side changed takes that side", () => {
    expect(clean("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n")).toBe("a\nB\nc\n");
    expect(clean("a\nb\nc\n", "a\nb\nc\n", "a\nb\nC\n")).toBe("a\nb\nC\n");
  });

  test("edits in different places both apply", () => {
    const base = "# Title\n\none\ntwo\nthree\nfour\nfive\n";
    const local = "# Title\n\nONE\ntwo\nthree\nfour\nfive\n";
    const remote = "# Title\n\none\ntwo\nthree\nfour\nFIVE\n";
    expect(clean(base, local, remote)).toBe("# Title\n\nONE\ntwo\nthree\nfour\nFIVE\n");
  });

  test("insertions at different places both apply", () => {
    const base = "a\nb\nc\nd\n";
    expect(clean(base, "start\na\nb\nc\nd\n", "a\nb\nc\nd\nend\n")).toBe("start\na\nb\nc\nd\nend\n");
  });

  test("a deletion on one side and an edit elsewhere on the other both apply", () => {
    const base = "a\nb\nc\nd\ne\n";
    expect(clean(base, "a\nc\nd\ne\n", "a\nb\nc\nd\nE\n")).toBe("a\nc\nd\nE\n");
  });

  test("the same edit on both sides is not a conflict", () => {
    const base = "a\nb\nc\n";
    expect(clean(base, "a\nX\nc\nnew\n", "a\nX\nc\n")).toBe("a\nX\nc\nnew\n");
  });

  test("overlapping different edits are a conflict", () => {
    expect(merge_text("a\nb\nc\n", "a\nlocal\nc\n", "a\nremote\nc\n").kind).toBe("conflict");
  });

  test("edits to adjacent lines are treated as overlapping", () => {
    expect(merge_text("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nC\nd\n").kind).toBe("conflict");
  });

  test("two different insertions at the same place are a conflict", () => {
    expect(merge_text("a\nb\n", "a\nx\nb\n", "a\ny\nb\n").kind).toBe("conflict");
  });

  test("a delete on one side and an edit of the same line on the other is a conflict", () => {
    expect(merge_text("a\nb\nc\n", "a\nc\n", "a\nB\nc\n").kind).toBe("conflict");
  });

  test("CRLF and LF compare equal and the local style is kept", () => {
    const base = "one\ntwo\nthree\nfour\n";
    const local = "ONE\r\ntwo\r\nthree\r\nfour\r\n";
    const remote = "one\ntwo\nthree\nFOUR\n";
    expect(clean(base, local, remote)).toBe("ONE\r\ntwo\r\nthree\r\nFOUR\r\n");
  });

  test("a local LF file merged with a CRLF remote stays LF", () => {
    const base = "one\r\ntwo\r\nthree\r\nfour\r\n";
    const local = "ONE\ntwo\nthree\nfour\n";
    const remote = "one\r\ntwo\r\nthree\r\nFOUR\r\n";
    expect(clean(base, local, remote)).toBe("ONE\ntwo\nthree\nFOUR\n");
  });

  test("a remote that only changed line endings keeps the local text", () => {
    expect(clean("a\nb\n", "a\nB\n", "a\r\nb\r\n")).toBe("a\nB\n");
  });

  test("a missing final newline is handled without joining lines", () => {
    expect(clean("a\nb", "a\nb\nc", "z\na\nb")).toBe("z\na\nb\nc");
    expect(clean("a\nb\n", "a\nb", "a\nb\nc\n")).toBe("a\nb\nc");
  });

  test("empty files", () => {
    expect(clean("", "", "x\n")).toBe("x\n");
    expect(clean("", "x\n", "")).toBe("x\n");
    expect(merge_text("", "x\n", "y\n").kind).toBe("conflict");
    expect(clean("a\n", "", "a\n")).toBe("");
  });

  test("never emits conflict markers", () => {
    const samples: [string, string, string][] = [
      ["a\nb\nc\n", "a\nx\nc\n", "a\ny\nc\n"],
      ["", "x", "y"],
      ["1\n2\n3\n4\n5\n6\n", "1\n2\nX\n4\n5\n6\n", "1\n2\n3\n4\nY\n6\n"],
    ];
    for (const [base, local, remote] of samples) {
      const result = merge_text(base, local, remote);
      if (result.kind === "clean") expect(has_conflict_markers(result.text)).toBe(false);
    }
  });

  test("conflict markers already in a note are detected", () => {
    expect(has_conflict_markers("a\n<<<<<<< HEAD\nb\n")).toBe(true);
    expect(has_conflict_markers("Title\n=======\n")).toBe(false);
  });

  test("random edits in separate regions always merge cleanly and keep both", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round += 1) {
      const lines = Array.from({ length: 40 }, (_, index) => `line ${index} ${Math.floor(random() * 1000)}`);
      const base = `${lines.join("\n")}\n`;
      const local_lines = [...lines];
      const remote_lines = [...lines];
      const local_at = Math.floor(random() * 15);
      const remote_at = 25 + Math.floor(random() * 15);
      local_lines[local_at] = `local edit ${round}`;
      remote_lines.splice(remote_at, 1, `remote edit ${round}`, `remote extra ${round}`);
      const merged = clean(base, `${local_lines.join("\n")}\n`, `${remote_lines.join("\n")}\n`);
      expect(merged).toContain(`local edit ${round}`);
      expect(merged).toContain(`remote edit ${round}`);
      expect(merged).toContain(`remote extra ${round}`);
      expect(merged.split("\n").length).toBe(base.split("\n").length + 1);
    }
  });

  test("random three-way merges never lose a line either side added", () => {
    let seed = 99;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let clean_count = 0;
    for (let round = 0; round < 300; round += 1) {
      const base = Array.from({ length: 12 }, (_, index) => `b${index}`);
      const mutate = (lines: string[], label: string) => {
        const copy = [...lines];
        const at = Math.floor(random() * copy.length);
        const kind = random();
        if (kind < 0.33) copy[at] = `${label}${round}`;
        else if (kind < 0.66) copy.splice(at, 0, `${label}${round}`);
        else copy.splice(at, 1);
        return copy;
      };
      const local = mutate(base, "L");
      const remote = mutate(base, "R");
      const result = merge_text(`${base.join("\n")}\n`, `${local.join("\n")}\n`, `${remote.join("\n")}\n`);
      if (result.kind === "conflict") continue;
      clean_count += 1;
      for (const line of [...local, ...remote]) {
        if (line.startsWith("L") || line.startsWith("R")) expect(result.text.split("\n")).toContain(line);
      }
    }
    expect(clean_count).toBeGreaterThan(100);
  });

  test("large files merge quickly", () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `row ${index}`);
    const local = [...lines];
    local[10] = "changed near the top";
    const remote = [...lines];
    remote[19_990] = "changed near the end";
    const started = Date.now();
    const merged = clean(lines.join("\n"), local.join("\n"), remote.join("\n"));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(merged).toContain("changed near the top");
    expect(merged).toContain("changed near the end");
  });

  test("completely different large files give up with a conflict instead of hanging", () => {
    const base = Array.from({ length: 5000 }, (_, index) => `base ${index}`).join("\n");
    const local = Array.from({ length: 5000 }, (_, index) => `local ${index}`).join("\n");
    const remote = Array.from({ length: 5000 }, (_, index) => `remote ${index}`).join("\n");
    expect(merge_text(base, local, remote).kind).toBe("conflict");
  });

  test("line matching finds the longest common subsequence", () => {
    const matches = matching_lines(["a", "b", "c", "d"], ["a", "c", "d", "e"]);
    expect(matches).toEqual([
      [0, 0],
      [2, 1],
      [3, 2],
    ]);
  });
});
