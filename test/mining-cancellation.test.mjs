import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import test from 'node:test';
import {runMiningProcess} from '../mining/src/workflow-lifecycle.mjs';

test('cancellation lists and removes only the run container on its configured Docker daemon', async t => {
  if (process.platform !== 'linux' || spawnSync('docker', ['--version']).status !== 0) {
    t.skip('runs with the Linux Docker client in the Agent image');
    return;
  }
  const label = 'devstar-mining-run=' + 'a'.repeat(32);
  const container = 'b'.repeat(64);
  const isRunContainer = url => [container, container.slice(0, 12)]
    .some(id => url.pathname.endsWith('/containers/' + id));
  const requests = [];
  const daemon = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push([req.method, url]);
    res.setHeader('API-Version', '1.41');
    if (url.pathname.endsWith('/_ping')) return res.end('OK');
    if (url.pathname.endsWith('/containers/json')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify([{Id: container}]));
    }
    if (isRunContainer(url)) {
      res.statusCode = 204;
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => daemon.close(resolve)));
  const controller = new AbortController();
  const active = runMiningProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: {
      PATH: process.env.PATH,
      DOCKER_HOST: 'tcp://127.0.0.1:' + daemon.address().port,
      DOCKER_API_VERSION: '1.41',
      MINING_EXECUTION_LABEL: label,
    },
    signal: controller.signal,
  });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(active, /test cancellation/);
  const operations = requests.filter(([, url]) => !url.pathname.endsWith('/_ping'));
  assert.equal(operations.length, 2);
  assert.equal(operations[0][0], 'GET');
  assert.ok(operations[0][1].pathname.endsWith('/containers/json'));
  assert.ok(operations[0][1].searchParams.get('filters').includes(label));
  assert.equal(operations[1][0], 'DELETE');
  assert.ok(isRunContainer(operations[1][1]));
  assert.equal(operations[1][1].searchParams.get('force'), '1');
});
