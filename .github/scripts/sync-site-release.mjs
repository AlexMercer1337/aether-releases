// Runs in aether-releases after publication. Never executes downloaded artifacts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_REPO = 'AlexMercer1337/aether-releases';
export const SITE_REPO = 'AlexMercer1337/aether-site';
const API = 'https://api.github.com';
const MAX_INSTALLER = 250 * 1024 * 1024;
const sha256 = data => createHash('sha256').update(data).digest('hex');
export function parseVersion(tag) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(tag);
  assert.ok(match, 'Expected a public version such as v0.1.0-beta.19');
  return { version: tag.replace(/^v/, ''), numbers: match.slice(1, 4).map(BigInt), beta: match[4] === undefined ? null : BigInt(match[4]) };
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (a.beta === b.beta) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta > b.beta ? 1 : -1;
}
export function describeRelease(release) {
  assert.equal(typeof release, 'object');
  const parsed = parseVersion(release.tag_name);
  const tag = `v${parsed.version}`;
  assert.equal(release.tag_name, tag, 'Only canonical public release tags are supported');
  assert.equal(release.draft, false, 'Draft releases cannot be advertised');
  assert.equal(release.prerelease, parsed.beta !== null, 'Release channel and version disagree');
  assert.ok(Number.isFinite(Date.parse(release.published_at)), 'Missing publication date');
  const url = `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`;
  assert.equal(release.html_url, url, 'Unexpected release repository');
  const filename = `Aether_${parsed.version}_x64-setup.exe`;
  const prefix = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/`;
  const assets = {};
  for (const name of [filename, 'SHA256SUMS.txt', 'latest.json', 'release-notes.md', `${filename}.sig`]) {
    const matches = release.assets.filter(asset => asset.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate release file: ${name}`);
    const asset = matches[0];
    assert.equal(asset.state, 'uploaded', `Incomplete release file: ${name}`);
    assert.equal(asset.browser_download_url, prefix + name, 'Unexpected asset URL');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= (name === filename ? MAX_INSTALLER : 131072), 'Invalid asset size');
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, 'Missing GitHub SHA-256');
    assets[name] = asset;
  }
  return { version: parsed.version, tag, prerelease: release.prerelease, publishedAt: release.published_at, releaseUrl: url, filename, assets };
}
export function verifyFiles(info, files) {
  const sums = new Map();
  const checksumText = files['SHA256SUMS.txt'].toString('utf8');
  for (const line of checksumText.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})[ \t]+\*?([^/\\\r\n]+)$/.exec(line);
    assert.ok(match && !sums.has(match[2]), 'Invalid or duplicate checksum record');
    sums.set(match[2], match[1]);
  }
  for (const [name, asset] of Object.entries(info.assets)) {
    const bytes = files[name];
    assert.ok(Buffer.isBuffer(bytes), 'Missing downloaded file');
    assert.equal(bytes.length, asset.size, `Size mismatch: ${name}`);
    const digest = sha256(bytes);
    assert.equal(`sha256:${digest}`, asset.digest, `GitHub digest mismatch: ${name}`);
    if (name !== 'SHA256SUMS.txt') assert.equal(digest, sums.get(name), `Published checksum mismatch: ${name}`);
  }
  assert.equal(files[info.filename].subarray(0, 2).toString(), 'MZ', 'Installer is not a Windows executable');
  const manifest = JSON.parse(files['latest.json'].toString('utf8'));
  assert.equal(manifest.version, info.version, 'Updater manifest version mismatch');
  assert.equal(manifest.platforms?.['windows-x86_64']?.url, info.assets[info.filename].browser_download_url, 'Updater URL mismatch');
  assert.equal(manifest.platforms['windows-x86_64'].signature.trim(), files[`${info.filename}.sig`].toString('utf8').trim(), 'Updater signature file mismatch');
  const notes = files['release-notes.md'].toString('utf8').split(/\r?\n/)
    .filter(line => /^-\s+\S/.test(line)).map(line => line.replace(/^-\s+/, '').trim()).slice(0, 5);
  assert.ok(notes.length > 0 && notes.every(note => note.length <= 600), 'Expected concise release change bullets');
  return { schema: 1, version: info.version, tag: info.tag, prerelease: info.prerelease, publishedAt: info.publishedAt,
    releaseUrl: info.releaseUrl, installer: { name: info.filename, url: info.assets[info.filename].browser_download_url,
      bytes: files[info.filename].length, sha256: sha256(files[info.filename]) },
    checksumsUrl: info.assets['SHA256SUMS.txt'].browser_download_url, changes: notes };
}
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function replaceOne(text, pattern, value, label) {
  const count = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))].length;
  assert.equal(count, 1, `Page template mismatch: ${label}`);
  return text.replace(pattern, () => value);
}
const date = (value, long = false) => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: long ? 'long' : '2-digit', year: 'numeric' }).format(new Date(value)).replace(/ г\.$/, '');
export function renderUpdate(html, readme, release, previous = null, now = new Date().toISOString()) {
  const active = /<section id="beta"[^>]*data-version="([^"]+)"/.exec(html)?.[1];
  assert.ok(active, 'Missing current download version');
  if (compareVersions(release.version, active) < 0) return { skipped: 'older-release', files: [] };
  if (previous?.version === release.version) {
    assert.equal(previous.installer.sha256, release.installer.sha256, 'Published installer was replaced; manual review required');
    assert.equal(previous.installer.url, release.installer.url, 'Published installer URL changed');
  }
  const verifiedAt = previous?.version === release.version ? previous.verifiedAt : now;
  const data = { ...release, verifiedAt };
  const esc = escapeHtml, label = release.prerelease ? `beta.${parseVersion(release.version).beta}` : release.version;
  let section = /<section id="beta"[\s\S]*?<\/section>/.exec(html)?.[0];
  assert.ok(section, 'Missing release panel');
  section = replaceOne(section, /data-version="[^"]+"/, `data-version="${esc(release.version)}"`, 'version');
  section = replaceOne(section, /data-verified-at="[^"]+"/, `data-verified-at="${verifiedAt.slice(0, 10)}"`, 'verification date');
  section = replaceOne(section, /<h2 id="beta-title">[\s\S]*?<\/h2>/, release.prerelease ? '<h2 id="beta-title">Aether ещё<br><span class="muted">становится собой</span></h2>' : '<h2 id="beta-title">Aether<br><span class="muted">для вашего дня</span></h2>', 'release introduction heading');
  section = replaceOne(section, /<p class="eyebrow">[\s\S]*?<\/p>/, `<p class="eyebrow"><span class="status-dot" aria-hidden="true"></span> ${release.prerelease ? 'ПРЕДВАРИТЕЛЬНЫЙ ВЫПУСК' : 'ВЫПУСК ДЛЯ WINDOWS'}</p>`, 'release introduction label');
  const intro = release.prerelease
    ? 'Стабильного публичного выпуска пока нет. Доступна тестовая версия для Windows x64. Познакомьтесь с интерфейсом выше или изучите условия беты перед установкой.'
    : 'Доступен публичный выпуск для Windows x64. Познакомьтесь с интерфейсом выше или изучите сведения о выпуске перед установкой.';
  section = replaceOne(section, /(<div class="beta-intro">[\s\S]*?<\/h2>)<p>[\s\S]*?<\/p>/, `${section.match(/(<div class="beta-intro">[\s\S]*?<\/h2>)/)[1]}<p>${intro}</p>`, 'release introduction');
  section = replaceOne(section, /<a class="text-link" href="[^"]+">/, `<a class="text-link" href="${esc(release.releaseUrl)}">`, 'release URL');
  section = replaceOne(section, /<div class="release-top">[\s\S]*?<\/div>/, `<div class="release-top"><span class="beta-label">${release.prerelease ? 'BETA' : 'РЕЛИЗ'}</span><span>${date(release.publishedAt, true)}</span></div>`, 'publication date');
  section = replaceOne(section, /<h3 id="release-title">[^<]+<\/h3>/, `<h3 id="release-title">${esc(release.version)}</h3>`, 'release heading');
  const mib = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(release.installer.bytes / 1048576);
  section = replaceOne(section, /<p class="release-subtitle">[\s\S]*?<\/p>/, `<p class="release-subtitle">Windows x64 <span>·</span> EXE <span>·</span> ${mib} МиБ</p>`, 'installer size');
  section = replaceOne(section, /<ul class="release-changes">[\s\S]*?<\/ul>/, `<ul class="release-changes">${release.changes.map(change => `<li>${esc(change)}</li>`).join('')}</ul>`, 'release notes');
  section = replaceOne(section, /<a class="button secondary download-link"[\s\S]*?<\/a>/, `<a class="button secondary download-link" href="${esc(release.installer.url)}">Скачать ${esc(label)} для Windows x64 <span aria-hidden="true">↓</span></a>`, 'download button');
  section = replaceOne(section, /<p class="verified">[\s\S]*?<\/p>/, `<p class="verified">Публичный файл и SHA-256 проверены ${date(verifiedAt)}.</p>`, 'verification label');
  section = replaceOne(section, /<details class="checksum">[\s\S]*?<\/details>/, `<details class="checksum"><summary>Контрольная сумма SHA-256</summary><code>${release.installer.sha256}</code><a href="${esc(release.checksumsUrl)}">Список контрольных сумм выпуска ↗</a></details>`, 'checksum');
  html = replaceOne(html, /<section id="beta"[\s\S]*?<\/section>/, section, 'release panel');
  html = replaceOne(html, /<a href="#beta" data-section-link>[^<]+<\/a>/, `<a href="#beta" data-section-link>${release.prerelease ? 'Бета-версия' : 'Скачать'}</a>`, 'release navigation');
  html = replaceOne(html, /<a class="button ghost" href="#beta">[\s\S]*?<\/a>/, `<a class="button ghost" href="#beta">${release.prerelease ? 'Условия беты' : 'О выпуске'} <span aria-hidden="true">↗</span></a>`, 'closing release link');
  html = replaceOne(html, /<details><summary>Что нужно для запуска\?<\/summary><p>[\s\S]*?<\/p><\/details>/,
    '<details><summary>Что нужно для запуска?</summary><p>Для запуска нужны Windows x64 и Microsoft Edge WebView2 Runtime. Результаты проверки установки и известные ограничения указаны в примечаниях выбранного выпуска. Этот установщик предназначен для x64; поддержка ARM64 не заявлена.</p></details>', 'system requirements');
  readme = replaceOne(readme, /Доступна \[тестовая версия для Windows x64\]\([^\n]+\)\. Стабильного выпуска пока нет\.|Доступен \[выпуск для Windows x64\]\([^\n]+\)\./,
    release.prerelease ? `Доступна [тестовая версия для Windows x64](${release.releaseUrl}). Стабильного выпуска пока нет.` : `Доступен [выпуск для Windows x64](${release.releaseUrl}).`, 'README release URL');
  return { skipped: null, files: [ { path: 'index.html', content: html }, { path: 'README.md', content: readme }, { path: 'release.json', content: `${JSON.stringify(data, null, 2)}\n` } ] };
}

async function responseBytes(response, limit) {
  assert.ok(response.ok, `HTTP ${response.status}`);
  const reader = response.body.getReader(), parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      assert.ok(length <= limit, 'Response exceeds size limit');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}
export async function publicDownload(address, limit, fetcher = fetch) {
  let url = new URL(address);
  for (let redirect = 0; redirect <= 4; redirect++) {
    assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.port && ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname), 'Untrusted download destination');
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(120000), headers: { Accept: url.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'Aether-site-release-sync' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      assert.ok(response.headers.get('location'), 'Redirect without destination');
      url = new URL(response.headers.get('location'), url);
    } else return responseBytes(response, limit);
  }
  throw new Error('Too many download redirects');
}
async function publicJson(path) {
  return JSON.parse((await publicDownload(`${API}/repos/${RELEASE_REPO}/${path}`, 2097152)).toString('utf8'));
}
export async function loadVerifiedRelease(tag, { retries = 0, fetchRelease = publicJson, download = publicDownload, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  parseVersion(tag);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const info = describeRelease(await fetchRelease(`releases/tags/${tag}`));
      const files = {};
      for (const [name, asset] of Object.entries(info.assets)) files[name] = await download(asset.browser_download_url, asset.size);
      return verifyFiles(info, files);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await pause(20000);
    }
  }
  throw lastError;
}
async function siteApi(path, token, body, method = 'GET', optional = false) {
  assert.ok(!/[?#]/.test(path), 'Unexpected API path');
  const response = await fetch(`${API}/repos/${SITE_REPO}/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Aether-site-release-sync', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (optional && response.status === 404) { await response.body?.cancel(); return null; }
  // Do not print GitHub response bodies or request headers, which may contain credentials.
  assert.ok(response.ok, `Site API ${method} ${path}: HTTP ${response.status}`);
  return JSON.parse((await responseBytes(response, 2097152)).toString('utf8'));
}
export async function syncSite({ tag, token, dryRun = false, output = null, retries = 0, getRelease = loadVerifiedRelease, requestSite = siteApi }) {
  assert.ok(dryRun || token, 'Add the AETHER_SITE_TOKEN Actions secret to aether-releases');
  const release = await getRelease(tag, { retries });
  const ref = await requestSite('git/ref/heads/main', token);
  const head = ref.object.sha;
  const commit = await requestSite(`git/commits/${head}`, token);
  const tree = await requestSite(`git/trees/${commit.tree.sha}`, token);
  async function read(path, optional = false) {
    const entry = tree.tree.find(item => item.path === path && item.type === 'blob');
    if (optional && !entry) return null;
    assert.ok(entry, `Missing site file ${path}`);
    const blob = await requestSite(`git/blobs/${entry.sha}`, token);
    assert.equal(blob.encoding, 'base64');
    return Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8');
  }
  const oldHtml = await read('index.html'), oldReadme = await read('README.md');
  const previousText = await read('release.json', true);
  const result = renderUpdate(oldHtml, oldReadme, release, previousText ? JSON.parse(previousText) : null);
  if (result.skipped) return { skipped: result.skipped, files: [] };
  const changed = result.files.filter(file => {
    const entry = tree.tree.find(item => item.path === file.path);
    const data = Buffer.from(file.content);
    return entry?.sha !== createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  });
  if (output) {
    await mkdir(output, { recursive: true });
    for (const file of result.files) await writeFile(resolve(output, file.path), file.content);
  }
  if (dryRun || changed.length === 0) return { version: release.version, dryRun, changed: changed.map(file => file.path), files: result.files };
  const newTree = await requestSite('git/trees', token, { base_tree: commit.tree.sha, tree: changed.map(file => ({ ...file, mode: '100644', type: 'blob' })) }, 'POST');
  const newCommit = await requestSite('git/commits', token, { message: `Update website download to ${release.version}`, tree: newTree.sha, parents: [head] }, 'POST');
  await requestSite('git/refs/heads/main', token, { sha: newCommit.sha, force: false }, 'PATCH');
  return { version: release.version, commit: newCommit.sha, changed: changed.map(file => file.path) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const outputIndex = process.argv.indexOf('--output');
    const result = await syncSite({ tag: process.env.AETHER_RELEASE_TAG, token: process.env.AETHER_SITE_TOKEN,
      dryRun: process.argv.includes('--dry-run'), retries: process.env.GITHUB_ACTIONS === 'true' ? 4 : 0,
      output: outputIndex >= 0 ? process.argv[outputIndex + 1] : null });
    console.log(JSON.stringify({ version: result.version, skipped: result.skipped, dryRun: result.dryRun, changed: result.changed, commit: result.commit }));
  } catch (error) {
    console.error(`Site synchronization stopped: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
