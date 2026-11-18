import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import test from "node:test";
import {fileURLToPath} from "node:url";

function json(response, status, body) {
  response.writeHead(status, {"Content-Type": "application/json"});
  response.end(body === undefined ? "" : JSON.stringify(body));
}

test("example Agent registers through the shared Runtime", async (t) => {
  const requests = [];
  let registered;
  const registration = new Promise((resolve) => { registered = resolve; });
  const server = createServer((request, response) => {
    requests.push({method: request.method, url: request.url});
    if (request.method === "POST" && request.url === "/-/agent-services/instances/register") {
      json(response, 200, {});
      registered();
      return;
    }
    if (request.method === "POST" && request.url === "/-/agent-services/instances/heartbeat") {
      json(response, 200, {});
      return;
    }
    if (request.method === "GET" && request.url === "/-/agent-services/instances/next-event") {
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 404, {message: "not found"});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const adapterPath = fileURLToPath(new URL("../src/adapter.mjs", import.meta.url));
  const child = spawn(process.execPath, [adapterPath], {
    env: {
      ...process.env,
      SELF_URL: `http://127.0.0.1:${server.address().port}`,
      DEVSTAR_TOKEN: "template-registration-test",
      DEVSTAR_AGENT_INSTANCE_ID: "1",
      DEVSTAR_AGENT_SCOPE_KIND: "repository",
      DEVSTAR_AGENT_SCOPE_REPO_ID: "42",
      AGENT_REPO_NAME: "template-agent",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(() => child.kill());

  await Promise.race([
    registration,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`registration timed out: ${stderr}`)), 5000)),
  ]);
  assert.deepEqual(requests[0], {
    method: "POST",
    url: "/-/agent-services/instances/register",
  });
});

test("example Agent receives and acknowledges a minimal task", async (t) => {
  const requests = [];
  let eventDelivered = false;
  let acknowledged;
  const acknowledgement = new Promise((resolve) => { acknowledged = resolve; });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      requests.push({method: request.method, url: request.url, body: body ? JSON.parse(body) : null});
      if (request.method === "POST" && request.url === "/-/agent-services/instances/register") {
        json(response, 200, {});
        return;
      }
      if (request.method === "POST" && request.url === "/-/agent-services/instances/heartbeat") {
        json(response, 200, {});
        return;
      }
      if (request.method === "GET" && request.url === "/-/agent-services/instances/next-event") {
        if (!eventDelivered) {
          eventDelivered = true;
          json(response, 200, {
            event_id: 23,
            body: {command: "template-smoke", source_event: "agent_command"},
          });
        } else {
          response.writeHead(204);
          response.end();
        }
        return;
      }
      if (request.method === "POST" && request.url === "/-/agent-services/events/23/ack") {
        json(response, 200, {});
        acknowledged(body ? JSON.parse(body) : null);
        return;
      }
      json(response, 404, {message: "not found"});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const adapterPath = fileURLToPath(new URL("../src/adapter.mjs", import.meta.url));
  const child = spawn(process.execPath, [adapterPath], {
    env: {
      ...process.env,
      SELF_URL: `http://127.0.0.1:${server.address().port}`,
      DEVSTAR_TOKEN: "template-task-test",
      DEVSTAR_AGENT_INSTANCE_ID: "1",
      DEVSTAR_AGENT_SCOPE_KIND: "repository",
      DEVSTAR_AGENT_SCOPE_REPO_ID: "42",
      AGENT_REPO_NAME: "template-agent",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(() => child.kill());

  const ackBody = await Promise.race([
    acknowledgement,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`acknowledgement timed out: ${stderr}`)), 5000)),
  ]);
  assert.equal(ackBody.summary, "Received command: template-smoke");
  assert.ok(requests.some(({url}) => url === "/-/agent-services/instances/register"));
});
