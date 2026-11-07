// Armin Mehri — mehri.armin@gmail.com
/** The error code of a failed API request: the API answers
 * `{"error": code}`; older handlers used `{"detail": code}`. */
export function errorCode(err: unknown): string | undefined {
  const data = (err as { response?: { data?: { error?: unknown; detail?: unknown } } } | undefined)
    ?.response?.data;
  const code = data?.error ?? data?.detail;
  return typeof code === "string" ? code : undefined;
}
