import { describe, expect, test } from "bun:test";
import {
  bool_flag,
  flag,
  list_flag,
  number_flag,
  parse_args,
  require_positional,
} from "../src/args.js";

describe("reading a command line", () => {
  test("bare words are positional", () => {
    expect(parse_args(["list", "abc"]).positional).toEqual(["list", "abc"]);
  });

  test("a long flag takes the next word", () => {
    const args = parse_args(["create", "--name", "openai"]);
    expect(args.positional).toEqual(["create"]);
    expect(flag(args, "name")).toBe("openai");
  });

  test("equals form works too", () => {
    expect(flag(parse_args(["--name=openai"]), "name")).toBe("openai");
  });

  test("-w takes the workspace that follows it", () => {
    const args = parse_args(["vault", "link", "notes", "-w", "Team"]);
    expect(args.positional).toEqual(["vault", "link", "notes"]);
    expect(flag(args, "workspace", "w")).toBe("Team");
  });

  test("-o and -d take a value, other short flags stay switches", () => {
    const args = parse_args(["export", "-o", "out.zip", "-y", "keep"]);
    expect(flag(args, "out", "o")).toBe("out.zip");
    expect(bool_flag(args, "yes", "y")).toBe(true);
    expect(args.positional).toEqual(["export", "keep"]);
  });

  test("a short value flag before another flag stays a switch", () => {
    expect(parse_args(["-w", "--json"]).flags.w).toBe(true);
  });

  test("a flag with no value is a boolean", () => {
    expect(bool_flag(parse_args(["delete", "--yes"]), "yes")).toBe(true);
  });

  test("a flag followed by another flag does not swallow it", () => {
    const args = parse_args(["--yes", "--name", "x"]);
    expect(bool_flag(args, "yes")).toBe(true);
    expect(flag(args, "name")).toBe("x");
  });

  test("short flags are booleans", () => {
    expect(bool_flag(parse_args(["-y"]), "y")).toBe(true);
  });

  test("everything after a double dash is positional", () => {
    const args = parse_args(["api", "--", "--not-a-flag"]);
    expect(args.positional).toEqual(["api", "--not-a-flag"]);
  });

  test("a missing flag reads as undefined, not empty string", () => {
    expect(flag(parse_args([]), "name")).toBeUndefined();
  });

  test("aliases are tried in order", () => {
    const args = parse_args(["--workspace", "team"]);
    expect(flag(args, "w", "workspace")).toBe("team");
  });

  test("a value that looks like a negative number is still read", () => {
    expect(flag(parse_args(["--limit=-1"]), "limit")).toBe("-1");
  });
});

describe("typed flags", () => {
  test("numbers parse", () => {
    expect(number_flag(parse_args(["--priority", "5"]), "priority")).toBe(5);
  });

  test("a number flag left off is undefined rather than zero", () => {
    expect(number_flag(parse_args([]), "priority")).toBeUndefined();
  });

  test("a value that is not a number is refused loudly", () => {
    expect(() => number_flag(parse_args(["--priority", "abc"]), "priority")).toThrow(
      'must be a number',
    );
  });

  test("zero survives, because it is a real priority", () => {
    expect(number_flag(parse_args(["--priority", "0"]), "priority")).toBe(0);
  });

  test("lists split on commas and drop blanks", () => {
    expect(list_flag(parse_args(["--email", "a@b.com, ,c@d.com"]), "email")).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });

  test("the string true counts as a set boolean", () => {
    expect(bool_flag(parse_args(["--json", "true"]), "json")).toBe(true);
  });
});

describe("required arguments", () => {
  test("a present argument comes back", () => {
    expect(require_positional(parse_args(["get", "abc"]), 1, "id")).toBe("abc");
  });

  test("a missing one names itself in the error", () => {
    expect(() => require_positional(parse_args(["get"]), 1, "provider id")).toThrow(
      "Missing required argument: provider id",
    );
  });
});
