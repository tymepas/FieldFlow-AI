import type { Activity } from "../types.ts";

/**
 * Which tracked Notion records a run may act on. Declared once by the model via
 * set_scope, validated here in code against the user's actual request text.
 *
 * - schedule_review: the user asked to review the scheduled operations in general.
 * - specific_activities: the user named particular tracked records (by id or activity name).
 * - not_tracked: the user asked about an event/activity/location that is not a tracked record.
 *   No weather, decision, Notion or Slack actions are allowed.
 */
export type ScopeMode = "schedule_review" | "specific_activities" | "not_tracked";

export interface RunScope {
  mode: ScopeMode;
  activityIds: Set<string>;
  description: string;
}

const stem = (w: string) => (w.length >= 5 ? w.slice(0, 5) : w);
const words = (s: string) => s.toLowerCase().match(/[a-z]+/g) ?? [];

/** Product/tool names users mention when asking for actions; never a subject of their own. */
const PRODUCT_NAMES = new Set(["notion", "slack", "openweather", "fieldflow", "claude", "swytchcode"]);
const CALENDAR_NAMES =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/;

/** Stems of every word that identifies tracked data: activity ids, activity names and locations. */
function trackedStems(loaded: Activity[]): Set<string> {
  const s = new Set<string>();
  for (const a of loaded) {
    for (const w of [...words(a.activity_id), ...words(a.activity_name), ...words(a.location)]) {
      if (w.length >= 3) s.add(stem(w));
    }
  }
  return s;
}

const PERSONAL_EVENT =
  /\b(?:i|we)\s*(?:(?:have|['’]ve)\s+(?:got\s+)?|(?:am|['’]m|are|['’]re)\s+(?:going\s+to|attending|hosting|organi[sz]ing|running|at)\s+|(?:got|attend|host)\s+)(?:a|an|my|our|the)?\s*([a-z][a-z-]+)/gi;

/**
 * Specific subjects the request introduces that are not tracked records: the signal that a
 * whole-schedule review would answer a different question than the one asked. Two small,
 * general signals rather than a topic dictionary:
 *  - proper names: capitalised words not at a sentence start (e.g. "Rohini", "Sector") that are
 *    not a tracked location/activity word, a product name, a weekday/month or an acronym;
 *  - personal-event framing: "I/we have a …", "I'm going to …", "we're hosting …" where the
 *    object is not a tracked activity word (e.g. "a hackathon").
 */
export function untrackedSubjects(request: string, loaded: Activity[]): string[] {
  const tracked = trackedStems(loaded);
  const isTracked = (w: string) => PRODUCT_NAMES.has(w) || tracked.has(stem(w));
  const found = new Set<string>();

  for (const m of request.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
    const word = m[0];
    if (!/^[A-Z][a-z]/.test(word)) continue; // not capitalised, or an acronym such as FA / ASAP
    const before = request.slice(0, m.index).trimEnd();
    if (before === "" || /[.!?:\n]$/.test(before)) continue; // sentence start
    const w = word.toLowerCase().replace(/['’].*$/, "");
    if (!isTracked(w) && !CALENDAR_NAMES.test(w)) found.add(word);
  }

  for (const m of request.matchAll(PERSONAL_EVENT)) {
    if (!isTracked(m[1].toLowerCase())) found.add(m[1]);
  }
  return [...found];
}

/**
 * True when the request explicitly refers to this record: its activity_id, or a
 * distinctive word of its activity_name (e.g. "solar", "antenna", "audit").
 * Location alone never counts — sharing a city is not a reference to an activity.
 */
export function requestReferencesActivity(request: string, activity: Activity): boolean {
  if (request.toLowerCase().includes(activity.activity_id.toLowerCase())) return true;
  const nameStems = new Set(words(activity.activity_name).filter((w) => w.length >= 4).map(stem));
  return words(request).some((w) => w.length >= 4 && nameStems.has(stem(w)));
}

/** Validate a set_scope call. Throws with a model-readable reason when the scope does not match the request. */
export function resolveScope(
  request: string,
  loaded: Activity[],
  input: { mode: ScopeMode; activity_ids?: string[]; date?: string; requested_description: string; untracked_subjects?: string[] },
): RunScope {
  const description = input.requested_description.trim();
  switch (input.mode) {
    case "not_tracked":
      return { mode: "not_tracked", activityIds: new Set(), description };

    case "schedule_review": {
      // The model must list anything specific the user asked about that is not tracked;
      // code re-checks the request for such subjects in case that list is incomplete.
      const declared = (input.untracked_subjects ?? []).map((s) => s.trim()).filter(Boolean);
      const subjects = [...new Set([...declared, ...untrackedSubjects(request, loaded)])];
      if (subjects.length > 0) {
        throw new Error(
          `The request is about something that is not a tracked record (${subjects.join(", ")}), so a schedule review would answer a different question. Use mode not_tracked (or specific_activities for tracked records the user named); do not broaden the request into a schedule review.`,
        );
      }
      const inScope = loaded.filter((a) => !input.date || a.date === input.date);
      return { mode: "schedule_review", activityIds: new Set(inScope.map((a) => a.activity_id)), description };
    }

    case "specific_activities": {
      const ids = input.activity_ids ?? [];
      if (ids.length === 0) throw new Error("specific_activities needs at least one activity_id.");
      for (const id of ids) {
        const a = loaded.find((x) => x.activity_id === id);
        if (!a) throw new Error(`Unknown activity_id "${id}". Use ids returned by read_activities.`);
        if (!requestReferencesActivity(request, a)) {
          throw new Error(
            `${id} (${a.activity_name}, ${a.location}) is not referenced by the request. Do not use a similar or "closest" record as a proxy; if the requested event/activity is not tracked, use mode not_tracked.`,
          );
        }
      }
      return { mode: "specific_activities", activityIds: new Set(ids), description };
    }
  }
}
