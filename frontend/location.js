/**
 * Browser location for "weather where I am right now". Uses only navigator.geolocation;
 * the browser shows its own permission prompt and nothing continues unless the user allows it.
 * The position is returned to the caller and never stored.
 */

const MESSAGES = {
  denied: "Location access was denied. Allow location access for this site in your browser, or type a place instead — for example, \"weather in Gurgaon Sector 59 tomorrow\".",
  unavailable: "Your browser could not determine your location. Try again, or type a place instead.",
  timeout: "Getting your location took too long. Try again, or type a place instead.",
  unsupported: "This browser does not support location access. Type a place instead.",
};

export function locationErrorMessage(reason) {
  return MESSAGES[reason] ?? MESSAGES.unavailable;
}

/**
 * @param geolocation navigator.geolocation (injectable for tests)
 * @returns {Promise<{ok:true, latitude:number, longitude:number, accuracy_m:number|null} | {ok:false, reason:string, message:string}>}
 */
export function requestBrowserLocation(geolocation = globalThis.navigator?.geolocation, timeoutMs = 15000) {
  if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
    return Promise.resolve({ ok: false, reason: "unsupported", message: locationErrorMessage("unsupported") });
  }
  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        resolve({ ok: true, latitude, longitude, accuracy_m: Number.isFinite(accuracy) ? accuracy : null });
      },
      (err) => {
        // GeolocationPositionError codes: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
        const reason = err?.code === 1 ? "denied" : err?.code === 3 ? "timeout" : "unavailable";
        resolve({ ok: false, reason, message: locationErrorMessage(reason) });
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}
