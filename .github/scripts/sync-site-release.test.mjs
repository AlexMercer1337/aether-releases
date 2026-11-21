import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describeRelease, verifyFiles, renderUpdate, compareVersions, parseVersion, publicDownload, loadVerifiedRelease, syncSite } from './sync-site-release.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
function fixture(version = '0.1.0-beta.19') {
  const tag = `v${version}`, name = `Aether_${version}_x64-setup.exe`;
  const base = `https://github.com/AlexMercer1337/aether-releases/releases/download/${tag}/`;
  const files = {
    [name]: Buffer.from('MZsynthetic installer; never executed'),
    [`${name}.sig`]: Buffer.from('synthetic-public-signature\n'),
    'latest.json': Buffer.from(JSON.stringify({ version, platforms: { 'windows-x86_64': { url: base + name, signature: 'synthetic-public-signature' } } })),
    'release-notes.md': Buffer.from('# Test release\n\n- A useful change\n- <script>alert("unsafe")</script> & text\n'),
  };
  files['SHA256SUMS.txt'] = Buffer.from(Object.entries(files).map(([key, value]) => `${digest(value)}  ${key}`).join('\n') + '\n');
  const release = { tag_name: tag, html_url: `https://github.com/AlexMercer1337/aether-releases/releases/tag/${tag}`,
    draft: false, prerelease: version.includes('-beta.'), published_at: '2026-11-21T19:49:16Z',
    assets: Object.entries(files).map(([key, value]) => ({ name: key, size: value.length, state: 'uploaded', digest: `sha256:${digest(value)}`, browser_download_url: base + key })) };
  return { release, files, info: describeRelease(release), name };
}
const html = await readFile(new URL('./fixtures/site.html', import.meta.url), 'utf8');
const readme = 'Aether\n\nДоступна [тестовая версия для Windows x64](https://github.com/AlexMercer1337/aether-releases/releases/tag/v0.1.0-beta.17). Стабильного выпуска пока нет.\n';

test('numeric version ordering prevents a republished beta.9 from replacing beta.19', () => {
  assert.equal(compareVersions('0.1.0-beta.9', '0.1.0-beta.19'), -1);
  assert.equal(compareVersions('0.1.0', '0.1.0-beta.19'), 1);
  assert.equal(compareVersions('0.2.0-beta.1', '0.1.0'), 1);
  for (const tag of ['closed-beta-channel', 'closed-beta-v0.1.0-beta.19', '../main', 'v01.1.0', 'v0.1.0-beta.19\nrun']) assert.throws(() => parseVersion(tag));
});
test('only complete, published, correctly classified public releases are accepted', () => {
  for (const change of [r => { r.draft = true; }, r => { r.prerelease = false; }, r => { r.assets.pop(); },
    r => { r.assets.push(r.assets[0]); }, r => { r.assets[0].state = 'new'; },
    r => { r.assets[0].browser_download_url = 'https://example.com/installer.exe'; },
    r => { r.assets[0].size = 0; }, r => { r.assets[0].digest = null; }]) {
    const { release } = fixture(); change(release); assert.throws(() => describeRelease(release));
  }
});
test('checks every downloaded file against GitHub metadata and SHA256SUMS', () => {
  const { info, files, name } = fixture();
  assert.equal(verifyFiles(info, files).installer.sha256, digest(files[name]));
  for (const key of Object.keys(files)) {
    const corrupt = { ...files, [key]: Buffer.from('corrupt') };
    assert.throws(() => verifyFiles(info, corrupt));
  }
});
test('a changed installer cannot be accepted by merely editing the published checksum list', () => {
  const { release, files, name } = fixture();
  files[name] = Buffer.from('MZattacker bytes');
  files['SHA256SUMS.txt'] = Buffer.from(`${digest(files[name])}  ${name}\n`);
  assert.throws(() => verifyFiles(describeRelease(release), files));
});
test('updater version, URL and signature must match even if all file hashes are consistent', () => {
  for (const change of [m => { m.version = '0.1.0-beta.18'; }, m => { m.platforms['windows-x86_64'].url = 'https://evil.example/file'; }, m => { m.platforms['windows-x86_64'].signature = 'different'; }]) {
    const f = fixture(), manifest = JSON.parse(f.files['latest.json']); change(manifest);
    f.files['latest.json'] = Buffer.from(JSON.stringify(manifest));
    f.files['SHA256SUMS.txt'] = Buffer.from(Object.entries(f.files).filter(([key]) => key !== 'SHA256SUMS.txt').map(([key, bytes]) => `${digest(bytes)}  ${key}`).join('\n') + '\n');
    f.release.assets = f.release.assets.map(a => ({ ...a, size: f.files[a.name].length, digest: `sha256:${digest(f.files[a.name])}` }));
    assert.throws(() => verifyFiles(describeRelease(f.release), f.files));
  }
});
test('updates download metadata and escapes release notes without relabelling demo screenshots', () => {
  const f = fixture(), data = verifyFiles(f.info, f.files);
  const result = renderUpdate(html, readme, data, null, '2026-11-22T10:00:00Z');
  const updated = result.files.find(file => file.path === 'index.html').content;
  assert.match(updated, /data-version="0\.1\.0-beta\.19"/);
  assert.match(updated, /Скачать beta\.19 для Windows x64/);
  assert.match(updated, new RegExp(data.installer.sha256));
  assert.match(updated, /&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt; &amp; text/);
  assert.doesNotMatch(updated, /<script>alert/);
  assert.match(updated, /реальные экраны beta\.17/);
  assert.match(updated, /study-plan\.jpg/);
  assert.match(updated, /t\.me\/aether_app_hub\?direct/);
  assert.match(result.files.find(file => file.path === 'README.md').content, /v0\.1\.0-beta\.19/);
});
test('repeat runs are idempotent, including the verification date', () => {
  const f = fixture(), data = verifyFiles(f.info, f.files);
  const a = renderUpdate(html, readme, data, null, '2026-11-22T10:00:00Z');
  const previous = JSON.parse(a.files[2].content);
  const b = renderUpdate(a.files[0].content, a.files[1].content, data, previous, '2026-11-23T10:00:00Z');
  assert.deepEqual(a.files, b.files);
});
test('old releases and template changes do not produce partial site updates', () => {
  const f = fixture('0.1.0-beta.9'), data = verifyFiles(f.info, f.files);
  const newerHtml = html.replace(/data-version="[^"]+"/, 'data-version="0.1.0-beta.19"');
  assert.equal(renderUpdate(newerHtml, readme, data).skipped, 'older-release');
  const current = fixture('0.1.0-beta.20'), currentData = verifyFiles(current.info, current.files);
  assert.throws(() => renderUpdate(html.replace('class="release-changes"', 'class="unknown-template"'), readme, currentData));
});
test('same-version installer replacement requires manual review', () => {
  const f = fixture(), data = verifyFiles(f.info, f.files);
  assert.throws(() => renderUpdate(html, readme, data, { ...data, installer: { ...data.installer, sha256: '0'.repeat(64) } }));
});
test('stable release is labelled as a release instead of a beta', () => {
  const f = fixture('0.1.0'), data = verifyFiles(f.info, f.files);
  const result = renderUpdate(html, readme, data);
  assert.match(result.files[0].content, /class="beta-label">РЕЛИЗ/);
  assert.match(result.files[0].content, /Доступен публичный выпуск/);
  assert.match(result.files[1].content, /Доступен \[выпуск для Windows x64\]/);
});
test('download redirect cannot carry credentials or reach an unrelated server', async () => {
  const calls = [];
  await assert.rejects(publicDownload('https://github.com/file', 10, async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } });
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  await assert.rejects(publicDownload('http://github.com/file', 10, async () => { throw Error('should not fetch'); }));
  await assert.rejects(publicDownload('https://secret@github.com/file', 10, async () => { throw Error('should not fetch'); }));
});
test('download size is bounded even without a Content-Length header', async () => {
  await assert.rejects(publicDownload('https://github.com/file', 2, async () => new Response('too long')));
});
test('publication with assets still uploading is retried before accepting the release', async () => {
  const f = fixture(); let calls = 0, waits = 0;
  const data = await loadVerifiedRelease(f.release.tag_name, { retries: 1,
    fetchRelease: async () => ++calls === 1 ? { ...f.release, assets: [] } : f.release,
    download: async url => f.files[decodeURIComponent(new URL(url).pathname.split('/').pop())], pause: async () => { waits++; } });
  assert.equal(data.version, '0.1.0-beta.19'); assert.equal(calls, 2); assert.equal(waits, 1);
});
function mockSite({ concurrentChange = false } = {}) {
  const calls = [];
  return { calls, requestSite: async (path, token, body, method = 'GET') => {
    calls.push({ path, body, method });
    if (path === 'git/ref/heads/main') return { object: { sha: 'original-head' } };
    if (path === 'git/commits/original-head') return { tree: { sha: 'original-tree' } };
    if (path === 'git/trees/original-tree') return { tree: [{ path: 'index.html', type: 'blob', sha: 'html' }, { path: 'README.md', type: 'blob', sha: 'readme' }] };
    if (path === 'git/blobs/html') return { encoding: 'base64', content: Buffer.from(html).toString('base64') };
    if (path === 'git/blobs/readme') return { encoding: 'base64', content: Buffer.from(readme).toString('base64') };
    if (path === 'git/trees' && method === 'POST') return { sha: 'new-tree' };
    if (path === 'git/commits' && method === 'POST') return { sha: 'new-head' };
    if (path === 'git/refs/heads/main' && method === 'PATCH') {
      if (concurrentChange) throw Error('HTTP 422: non-fast-forward');
      return { object: { sha: 'new-head' } };
    }
    throw Error('Unexpected API call');
  } };
}
test('one commit updates exactly three files and preserves concurrent website changes', async () => {
  const f = fixture(), data = verifyFiles(f.info, f.files), mock = mockSite();
  await syncSite({ tag: f.release.tag_name, token: 'synthetic-test-token', getRelease: async () => data, requestSite: mock.requestSite });
  const writes = mock.calls.filter(call => call.method !== 'GET');
  assert.deepEqual(writes.map(call => call.path), ['git/trees', 'git/commits', 'git/refs/heads/main']);
  assert.equal(writes[0].body.base_tree, 'original-tree');
  assert.deepEqual(writes[0].body.tree.map(file => file.path), ['index.html', 'README.md', 'release.json']);
  assert.deepEqual(writes[1].body.parents, ['original-head']);
  assert.equal(writes[2].body.force, false);
  const conflict = mockSite({ concurrentChange: true });
  await assert.rejects(syncSite({ tag: f.release.tag_name, token: 'synthetic-test-token', getRelease: async () => data, requestSite: conflict.requestSite }), /422/);
});
test('failed verification and a dry run never write to GitHub', async () => {
  const mock = mockSite(), f = fixture(), data = verifyFiles(f.info, f.files);
  await assert.rejects(syncSite({ tag: f.release.tag_name, token: 'synthetic-test-token', getRelease: async () => { throw Error('checksum mismatch'); }, requestSite: mock.requestSite }));
  assert.equal(mock.calls.length, 0);
  await syncSite({ tag: f.release.tag_name, dryRun: true, getRelease: async () => data, requestSite: mock.requestSite });
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});
