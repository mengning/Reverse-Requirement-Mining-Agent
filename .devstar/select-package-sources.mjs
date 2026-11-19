import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const debian = 'https://deb.debian.org/debian';
const security = 'https://deb.debian.org/debian-security';
const pypi = 'https://pypi.org/simple';
const ustcDebian = 'https://mirrors.ustc.edu.cn/debian';
const ustcPyPI = 'https://mirrors.ustc.edu.cn/pypi/simple';
const wheel = 'programbench-1.2.5-py3-none-any.whl';
const wheelUrl = 'https://files.pythonhosted.org/packages/05/47/0c0a5a282eb6b4e0603e9db88144afd306cc5af812b513ab3ab1ee290f72/' + wheel;
const sampleBytes = 256 * 1024;

export function httpsSource(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      /[\s\\]/.test(value)) throw new Error('Package sources must be plain HTTPS URLs without credentials');
  return url.href.replace(/\/$/, '');
}

export function replaceAptSources(config, primary, updates) {
  const result = config.replace(/^URIs:[ \t]+https?:\/\/deb\.debian\.org\/debian(-security)?[ \t]*$/gm,
    (_, secure) => 'URIs: ' + (secure ? updates : primary));
  if (!result.includes('URIs: ' + primary) || !result.includes('URIs: ' + updates)) {
    throw new Error('Expected Bookworm archive and security sources');
  }
  return result;
}

async function get(url, options, redirects = 0) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Unsafe redirect');
  const response = await fetch(target, {...options, redirect: 'manual'});
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects >= 4) throw new Error('Too many redirects');
    return get(new URL(location, target), options, redirects + 1);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('HTTP ' + response.status);
  }
  return response;
}

async function measure(name, source, resource) {
  const signal = AbortSignal.timeout(45000);
  const started = performance.now();
  try {
    const url = await resource(signal);
    const response = await get(url, {signal, headers: {Range: 'bytes=0-' + (sampleBytes - 1)}});
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (bytes < sampleBytes) {
        const {value, done} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (bytes < sampleBytes) throw new Error('Incomplete sample');
    const ms = Math.round(performance.now() - started);
    console.log(`source-probe ${name} ${source} ${sampleBytes} bytes ${ms} ms`);
    return {source, ms};
  } catch (error) {
    console.log(`source-probe ${name} ${source} unavailable (${error.name === 'TimeoutError' ? 'timeout' : 'download failed'})`);
    return null;
  }
}

async function mirrorWheel(signal) {
  const page = ustcPyPI + '/programbench/';
  const response = await get(page, {signal});
  const html = await response.text();
  const links = Array.from(html.matchAll(/href=(?:"([^"]+)"|'([^']+)')/gi), m => m[1] || m[2]);
  const match = links.map(link => new URL(link, page)).find(url => url.pathname.endsWith('/' + wheel));
  if (!match) throw new Error('Pinned wheel not present');
  return match;
}

export function bestSource(results, fallback) {
  return results.filter(Boolean).sort((a, b) => a.ms - b.ms)[0]?.source || fallback;
}

async function configure(env) {
  let apt = httpsSource(env.MINING_APT_MIRROR || debian);
  const aptSecurity = httpsSource(env.MINING_APT_SECURITY_MIRROR || security);
  let index = httpsSource(env.MINING_PYPI_INDEX || pypi);
  if (env.MINING_PROBE_SOURCES === '1') {
    const arch = {x64: 'amd64', arm64: 'arm64'}[process.arch];
    if (!arch) throw new Error('Unsupported architecture for mirror comparison');
    const aptResource = source => () => source + '/dists/bookworm/main/binary-' + arch + '/Packages.xz';
    const [a, b, c, d] = await Promise.all([
      measure('apt', debian, aptResource(debian)),
      measure('apt', ustcDebian, aptResource(ustcDebian)),
      measure('pypi', pypi, () => wheelUrl),
      measure('pypi', ustcPyPI, mirrorWheel),
    ]);
    if (!env.MINING_APT_MIRROR) apt = bestSource([a, b], apt);
    if (!env.MINING_PYPI_INDEX) index = bestSource([c, d], index);
  }
  const config = '/etc/apt/sources.list.d/debian.sources';
  writeFileSync(config, replaceAptSources(readFileSync(config, 'utf8'), apt, aptSecurity));
  writeFileSync('/tmp/mining-pypi-index', index);
  console.log(`source-selected apt=${apt} apt-security=${aptSecurity} pypi=${index}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await configure(process.env);
}
