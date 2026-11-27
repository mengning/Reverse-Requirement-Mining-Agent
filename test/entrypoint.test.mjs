import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {fileURLToPath} from "node:url";

const entrypointPath = fileURLToPath(new URL("../.devstar/entrypoint.sh", import.meta.url));
const workflowPath = fileURLToPath(new URL("../.devstar/workflows/ci.yaml", import.meta.url));
const gitmodulesPath = fileURLToPath(new URL("../.gitmodules", import.meta.url));

test("Runtime checkout keeps Git credentials separate from the event-bus token", async () => {
  const entrypoint = await readFile(entrypointPath, "utf8");

  assert.match(
    entrypoint,
    /runtime_token="\$\{DEVSTAR_RUNTIME_GIT_TOKEN:-\$\{DEVSTAR_SERVICE_ACCOUNT_TOKEN:-\}\}"/,
  );
  assert.doesNotMatch(entrypoint, /runtime_token=.*DEVSTAR_TOKEN/);
  assert.doesNotMatch(entrypoint, /runtime_token=.*GITEA_TOKEN/);
  assert.doesNotMatch(entrypoint, /runtime_token=.*GITHUB_TOKEN/);
});

test("project layout separates business source from hidden Runtime", async () => {
  const [entrypoint, gitmodules] = await Promise.all([
    readFile(entrypointPath, "utf8"),
    readFile(gitmodulesPath, "utf8"),
  ]);

  assert.match(entrypoint, /runtime_rel="\.devstar\/agent-runtime"/);
  assert.match(entrypoint, /ADAPTER_CMD="\$\{ADAPTER_CMD:-node src\/adapter\.mjs\}"/);
  assert.match(gitmodules, /path = \.devstar\/agent-runtime/);
});

test("container startup uses the bundled Runtime without repository metadata", async () => {
  const entrypoint = await readFile(entrypointPath, "utf8");

  assert.match(entrypoint, /elif \[ -f "\$runtime_path\/bootstrap\/entrypoint\.sh" \]; then/);
  assert.match(entrypoint, /Using bundled Agent Runtime/);
  assert.match(entrypoint, /DEVSTAR_AGENT_RUNTIME_COMMIT:-bundled/);
});

test("CI passes its Git token through the dedicated Runtime credential", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /DEVSTAR_RUNTIME_GIT_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /-e DEVSTAR_RUNTIME_GIT_TOKEN/);
  assert.doesNotMatch(workflow, /DEVSTAR_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test("the DevStar template builds the same official runner as the CLI and CI", async () => {
  const config = JSON.parse(await readFile(new URL("../.devstar/devcontainer.json", import.meta.url), "utf8"));
  const dockerfile = await readFile(new URL("../.devstar/Dockerfile", import.meta.url), "utf8");
  assert.deepEqual(config.build, {dockerfile: "Dockerfile", context: ".."});
  assert.equal(dockerfile.match(/^FROM /gm)?.length, 1);
  assert.match(dockerfile, /apt-get install.*docker\.io/);
  assert.match(dockerfile, /COPY mining\/requirements-baseline\.txt/);
  assert.match(dockerfile, /pip install --no-cache-dir -r \/tmp\/mining-requirements\.txt/);
  assert.match(dockerfile, /ENV MINING_PYTHON=\/opt\/programbench\/bin\/python/);
  assert.match(dockerfile, /ENTRYPOINT.*\.devstar\/entrypoint\.sh/);
});

test("removed execution modes fail instead of silently running the official runner", () => {
  const adapter = fileURLToPath(new URL("../src/adapter.mjs", import.meta.url));
  for (const backend of ["sd-pod", "pinned-stdin-pod"]) {
    const result = spawnSync(process.execPath, [adapter], {
      env: {...process.env, MINING_EXECUTION_BACKEND: backend}, encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Only the official ProgramBench execution backend is supported/);
  }
});
