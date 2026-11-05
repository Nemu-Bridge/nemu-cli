import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import { adjacencyGraphs, dictionary } from "@zxcvbn-ts/language-common";

export const MIN_PASSWORD_LENGTH = 12;
export const STRONG_SCORE = 4;
export const LONG_PASSWORD_LENGTH = 14;
export const LONG_PASSWORD_SCORE = 3;

let checker: ZxcvbnFactory | null = null;

function factory(): ZxcvbnFactory {
  checker ??= new ZxcvbnFactory({ dictionary, graphs: adjacencyGraphs });
  return checker;
}

export function password_problem(password: string, context: string[] = []): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  const { score } = factory().check(password, context);
  const is_strong =
    score >= STRONG_SCORE || (password.length >= LONG_PASSWORD_LENGTH && score >= LONG_PASSWORD_SCORE);
  if (!is_strong) {
    return "That password is too easy to guess. Add words or characters that do not follow a pattern.";
  }
  return null;
}
