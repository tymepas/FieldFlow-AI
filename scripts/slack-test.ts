/**
 * Send one test message to the ops channel through Swytchcode.
 *
 *   npx tsx scripts/slack-test.ts
 */
import { postMessage } from "../src/integrations/slack.ts";

const res = await postMessage("FieldFlow AI test message: Slack integration via Swytchcode is working.");
console.log("posted", res);
