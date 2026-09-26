import { callTool, ToolCallError } from "../swytch.ts";

/** gmail.user.profile.get — the connected account's own address (the only recipient we send to). */
export async function getConnectedAddress(): Promise<string> {
  const profile = await callTool("gmail.user.profile.get", { userId: "me" });
  const address = profile?.emailAddress;
  if (typeof address !== "string" || !address.includes("@")) throw new ToolCallError("gmail.user.profile.get", "no email address on the connected account");
  return address;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** RFC 2822 plain-text message, UTF-8 safe (encoded-word subject, base64 body). */
export function buildRawMessage(to: string, subject: string, text: string): string {
  const body = b64(text).replace(/.{1,76}/g, "$&\r\n");
  const mime = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

/** gmail.user.send.create1 (POST /gmail/v1/users/me/messages/send). Returns the Gmail message id. */
export async function sendEmail(to: string, subject: string, text: string): Promise<string> {
  const sent = await callTool("gmail.user.send.create1", { userId: "me", body: { raw: buildRawMessage(to, subject, text) } });
  if (typeof sent?.id !== "string") throw new ToolCallError("gmail.user.send.create1", "Gmail did not return a message id");
  return sent.id;
}
