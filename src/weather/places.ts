/**
 * Place directory for AD-HOC requests (a user's own event or visit), kept separate from the
 * tracked Notion activities. SwytchCode's OpenWeather integration accepts only lat/lon and has
 * no geocoding method, so places are resolved here; a place not in the directory falls back to
 * the agent's estimate, which is labelled as such everywhere it is shown.
 *
 * Coordinates were looked up once in OpenStreetMap (Nominatim) and pinned here; nothing is
 * geocoded at runtime.
 */
export interface KnownPlace {
  name: string;
  latitude: number;
  longitude: number;
  /** Where the coordinates come from, shown to the user. */
  source: string;
}

const PLACES: Array<KnownPlace & { aliases: string[] }> = [
  {
    name: "Gurgaon Sector 59",
    latitude: 28.4030162,
    longitude: 77.1066682,
    source: "OpenStreetMap node 2735984441",
    // Bare "sector 59" is deliberately not an alias: Noida also has a Sector 59.
    aliases: ["gurgaon sector 59", "sector 59 gurgaon", "gurugram sector 59", "sector 59 gurugram"],
  },
  {
    name: "Rohini, Delhi",
    latitude: 28.7063083,
    longitude: 77.1087892,
    source: "OpenStreetMap relation 21182288",
    aliases: ["rohini", "rohini delhi", "rohini new delhi"],
  },
];

/** Lower-case, unify Gurugram/Gurgaon, drop punctuation and trailing region/country words. */
export function normalizePlace(place: string): string {
  return place
    .toLowerCase()
    .replace(/gurugram/g, "gurgaon")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(haryana|india)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolvePlace(place: string): KnownPlace | undefined {
  const key = normalizePlace(place);
  const hit = PLACES.find((p) => p.aliases.includes(key));
  if (!hit) return undefined;
  const { aliases, ...known } = hit;
  return known;
}
