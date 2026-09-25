import { exec, isSwytchcodeError } from "@swytchcode/runtime";

/**
 * Envelope returned by `swytchcode exec --json` (verified live, CLI 2.23.3):
 * `{ data: <provider JSON>, request: { method, url }, status_code }`.
 */
interface ExecEnvelope<T> {
  data: T;
  request?: { method: string; url: string };
  status_code?: number;
}

export class ToolCallError extends Error {
  constructor(
    readonly canonicalId: string,
    message: string,
    readonly category?: string,
  ) {
    super(`${canonicalId}: ${message}`);
  }
}

/**
 * Execute a Swytchcode tool and return the provider payload (`data`).
 * Provider/CLI errors are rethrown as ToolCallError with the CLI's error
 * category — never swallowed.
 */
export async function callTool<T = any>(canonicalId: string, args: Record<string, unknown>): Promise<T> {
  let result: ExecEnvelope<T>;
  try {
    result = (await exec(canonicalId, args, { timeoutMs: 60_000 })) as ExecEnvelope<T>;
  } catch (e) {
    if (isSwytchcodeError(e)) {
      // The CLI's classified error is embedded in the message alongside log lines.
      const classified = e.message.match(/\{"error":"(.*?)","category":"(\w+)"/);
      throw new ToolCallError(canonicalId, classified?.[1] ?? e.message, classified?.[2] ?? e.details?.category);
    }
    throw e;
  }
  return result.data;
}
