export type BrowserLocationResult =
  | { ok: true; latitude: number; longitude: number; accuracy_m: number | null }
  | { ok: false; reason: "denied" | "unavailable" | "timeout" | "unsupported"; message: string };

export function locationErrorMessage(reason: string): string;
export function requestBrowserLocation(geolocation?: unknown, timeoutMs?: number): Promise<BrowserLocationResult>;
