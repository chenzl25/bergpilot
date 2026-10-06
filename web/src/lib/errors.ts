/** Text for a failed request. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
