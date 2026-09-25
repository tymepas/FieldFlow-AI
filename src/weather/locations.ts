/**
 * Coordinates for the small, fixed set of operating locations.
 * The OpenWeather tools accept lat/lon only and the bundle has no geocoding
 * method, so the MVP resolves a location name here instead of building a
 * geocoding system. Add a row to support a new site.
 */
export const LOCATIONS: Record<string, { lat: number; lon: number; utc_offset: string }> = {
  gurgaon: { lat: 28.4595, lon: 77.0266, utc_offset: "+05:30" },
  "new delhi": { lat: 28.6139, lon: 77.209, utc_offset: "+05:30" },
  noida: { lat: 28.5355, lon: 77.391, utc_offset: "+05:30" },
  faridabad: { lat: 28.4089, lon: 77.3178, utc_offset: "+05:30" },
  jaipur: { lat: 26.9124, lon: 75.7873, utc_offset: "+05:30" },
  mumbai: { lat: 19.076, lon: 72.8777, utc_offset: "+05:30" },
};

export function resolveLocation(name: string) {
  const loc = LOCATIONS[name.trim().toLowerCase()];
  if (!loc) {
    throw new Error(`Unknown location "${name}". Known: ${Object.keys(LOCATIONS).join(", ")}`);
  }
  return loc;
}
