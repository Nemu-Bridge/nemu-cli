export class CliError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly reference: string | undefined;

  constructor(
    message: string,
    code: string,
    options: { status?: number; reference?: string } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.status = options.status;
    this.reference = options.reference;
  }
}

export function error_code(error: unknown): string {
  if (error instanceof CliError) return error.code;
  if (error instanceof Error && error.name !== "Error") {
    return error.name
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 64);
  }
  return "unexpected";
}
