import { callTool, ToolCallError } from "../swytch.ts";

const CHANNEL_NAME = (process.env.SLACK_CHANNEL ?? "field-ops").replace(/^#/, "");

/**
 * Both Slack methods fail CLI validation without a `token` input even though
 * auth is managed; a top-level value is sent as an inert `Token` header while
 * the real credential is injected as `Authorization` (verified by dry-run).
 */
const TOKEN_PLACEHOLDER = { token: "managed-by-swytchcode" };

let channelId: string | undefined;

/** slack.conversations.list.list — resolve the ops channel name to its id. */
export async function getChannelId(): Promise<string> {
  if (channelId) return channelId;
  // Do not pass `token` here: this method sends it as a query param, which overrides auth.
  const res = await callTool("slack.conversations.list.list", {
    types: "public_channel",
    exclude_archived: true,
    limit: 200,
  });
  if (!res.ok) throw new ToolCallError("slack.conversations.list.list", res.error ?? "not ok");
  const channel = res.channels.find((c: any) => c.name === CHANNEL_NAME);
  if (!channel) throw new Error(`Slack channel #${CHANNEL_NAME} not found`);
  if (!channel.is_member) throw new Error(`Bot is not a member of #${CHANNEL_NAME} — run /invite @swytchcode there`);
  channelId = channel.id as string;
  return channelId;
}

/** slack.chat.postmessage.create — post a message to the ops channel. */
export async function postMessage(text: string, blocks?: unknown[]): Promise<{ channel: string; ts: string }> {
  const channel = await getChannelId();
  const res = await callTool("slack.chat.postmessage.create", {
    ...TOKEN_PLACEHOLDER,
    body: { channel, text, ...(blocks ? { blocks: JSON.stringify(blocks) } : {}) },
  });
  // Slack reports failures as HTTP 200 with ok:false.
  if (!res.ok) throw new ToolCallError("slack.chat.postmessage.create", res.error ?? "not ok");
  return { channel: res.channel, ts: res.ts };
}
