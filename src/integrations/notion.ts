import { callTool } from "../swytch.ts";
import type { Activity } from "../types.ts";

/** Dedicated FieldFlow page (found via notion.search.create). Override with NOTION_ROOT_PAGE_ID. */
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID ?? "3e623caa-e128-81bf-aed0-ca92e92c83ec";
const TABLE_TITLE = process.env.NOTION_TABLE_TITLE ?? "Field Activities";

export const ACTIVITY_FIELDS = [
  "activity_id",
  "activity_name",
  "location",
  "date",
  "start_time",
  "activity_type",
  "priority",
  "stakeholder",
  "status",
  "notes",
] as const;
type Field = (typeof ACTIVITY_FIELDS)[number];

/** Property name → Notion property type, read from the live data source. */
export type Schema = Record<string, string>;

export interface ActivitiesTable {
  databaseId: string;
  dataSourceId: string;
  schema: Schema;
}

let cached: ActivitiesTable | undefined;

/** Locate the "Field Activities" inline table on the FieldFlow page and read its schema. */
export async function getActivitiesTable(): Promise<ActivitiesTable> {
  if (cached) return cached;
  const children = await callTool("notion.children.get", { block_id: ROOT_PAGE_ID, page_size: 100 });
  const block = children.results.find(
    (b: any) => b.type === "child_database" && b.child_database?.title?.trim() === TABLE_TITLE,
  );
  if (!block) {
    throw new Error(`No inline table titled "${TABLE_TITLE}" on the FieldFlow page ${ROOT_PAGE_ID}`);
  }
  const db = await callTool("notion.databas.get", { database_id: block.id });
  const dataSourceId: string | undefined = db.data_sources?.[0]?.id;
  if (!dataSourceId) throw new Error(`Database ${block.id} has no data source`);
  const ds = await callTool("notion.data_source.get", { data_source_id: dataSourceId });
  const schema: Schema = {};
  for (const [name, prop] of Object.entries<any>(ds.properties)) schema[name] = prop.type;

  const missing = ACTIVITY_FIELDS.filter((f) => !(f in schema));
  if (missing.length) throw new Error(`"${TABLE_TITLE}" is missing columns: ${missing.join(", ")}`);

  cached = { databaseId: block.id, dataSourceId, schema };
  return cached;
}

function readText(prop: any): string {
  switch (prop?.type) {
    case "title":
    case "rich_text":
      return prop[prop.type].map((t: any) => t.plain_text).join("");
    case "select":
    case "status":
      return prop[prop.type]?.name ?? "";
    case "date":
      return prop.date?.start ?? "";
    case "number":
      return prop.number === null ? "" : String(prop.number);
    default:
      throw new Error(`Unsupported Notion property type "${prop?.type}"`);
  }
}

/** Encode a plain string for a Notion property of the given type. */
export function encode(type: string, value: string): unknown {
  switch (type) {
    case "title":
    case "rich_text":
      return { [type]: value ? [{ type: "text", text: { content: value.slice(0, 2000) } }] : [] };
    case "select":
    case "status":
      return { [type]: value ? { name: value } : null };
    case "date":
      return { date: value ? { start: value } : null };
    default:
      throw new Error(`Unsupported Notion property type "${type}"`);
  }
}

function toActivity(page: any): Activity {
  const a: Record<string, string> = {};
  for (const f of ACTIVITY_FIELDS) a[f] = readText(page.properties[f]);
  return { ...(a as unknown as Activity), page_id: page.id };
}

/** notion.query.create — read every activity row. */
export async function readActivities(): Promise<Activity[]> {
  const { dataSourceId } = await getActivitiesTable();
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const res = await callTool("notion.query.create", {
      data_source_id: dataSourceId,
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows.map(toActivity);
}

/** notion.page.create — add one activity row. */
export async function createActivity(activity: Omit<Activity, "page_id">): Promise<string> {
  const { dataSourceId, schema } = await getActivitiesTable();
  const properties: Record<string, unknown> = {};
  for (const f of ACTIVITY_FIELDS) properties[f] = encode(schema[f], activity[f as Field]);
  const page = await callTool("notion.page.create", {
    body: { parent: { type: "data_source_id", data_source_id: dataSourceId }, properties },
  });
  return page.id;
}

/** notion.page.update — set status and notes on an activity row. */
export async function updateActivity(pageId: string, fields: Partial<Pick<Activity, "status" | "notes">>) {
  const { schema } = await getActivitiesTable();
  const properties: Record<string, unknown> = {};
  for (const [f, v] of Object.entries(fields)) properties[f] = encode(schema[f], v as string);
  await callTool("notion.page.update", { page_id: pageId, body: { properties } });
}
