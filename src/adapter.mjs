import {runDevstarAgent, extractCommand, replyToSourceComment, extractSourceEvent} from "../.devstar/agent-runtime/src/index.mjs";

async function handleEvent(eventPayload, env) {
  const command = extractCommand(eventPayload);

  // TODO: Replace this with your agent logic
  const result = `Received command: ${command}`;

  // If the event came from an issue/PR comment, reply to it
  const sourceEvent = extractSourceEvent(eventPayload);
  if (sourceEvent === "issue_comment" || sourceEvent === "pull_request_comment") {
    await replyToSourceComment(eventPayload, result);
  }

  return {summary: result};
}

await runDevstarAgent({handleEvent});
