import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const VERTEX_KEYS = [
  'USE_VERTEX_AI',
  'VERTEX_IMAGE_ACCOUNTS',
  'VERTEX_LOCATION',
  'VERTEX_IMAGE_RPM',
  'VERTEX_MAIN_PROJECT',
  'VERTEX_MAIN_CREDENTIALS',
  'VERTEX_MAIN_CREDENTIALS_JSON',
  'VERTEX_ALT1_PROJECT',
  'VERTEX_ALT1_CREDENTIALS',
  'VERTEX_ALT1_CREDENTIALS_JSON',
  'VERTEX_DEPLOYED_PROJECT',
  'VERTEX_DEPLOYED_CREDENTIALS_JSON',
];

const clearVertexEnv = () => {
  for (const key of VERTEX_KEYS) delete process.env[key];
};

test('loads a complete independent file-backed account pool', async () => {
  clearVertexEnv();
  const fixtureDir = mkdtempSync(join(tmpdir(), 'contentmachine-vertex-'));
  const mainCredentials = join(fixtureDir, 'main.json');
  const altCredentials = join(fixtureDir, 'alt.json');
  writeFileSync(mainCredentials, '{}');
  writeFileSync(altCredentials, '{}');
  process.env.USE_VERTEX_AI = 'true';
  process.env.VERTEX_IMAGE_ACCOUNTS = 'main,alt1';
  process.env.VERTEX_MAIN_PROJECT = 'main-project';
  process.env.VERTEX_MAIN_CREDENTIALS = mainCredentials;
  process.env.VERTEX_ALT1_PROJECT = 'alt-project';
  process.env.VERTEX_ALT1_CREDENTIALS = altCredentials;

  const vertex = await import(`./vertex.js?independent=${Date.now()}`);
  assert.equal(vertex.isVertexConfigured(), true);
  assert.equal(vertex.vertexAccountCount(), 2);
  assert.equal(vertex.vertexConfigError(), null);
});

test('accepts base64 Google credential JSON for independent deployment', async () => {
  clearVertexEnv();
  process.env.USE_VERTEX_AI = 'true';
  process.env.VERTEX_IMAGE_ACCOUNTS = 'deployed';
  process.env.VERTEX_DEPLOYED_PROJECT = 'deployed-project';
  process.env.VERTEX_DEPLOYED_CREDENTIALS_JSON = Buffer.from(JSON.stringify({
    type: 'authorized_user',
    client_id: 'not-used-by-this-configuration-test',
    client_secret: 'not-used-by-this-configuration-test',
    refresh_token: 'not-used-by-this-configuration-test',
  })).toString('base64');

  const vertex = await import(`./vertex.js?deployed=${Date.now()}`);
  assert.equal(vertex.isVertexConfigured(), true);
  assert.equal(vertex.vertexAccountCount(), 1);
  assert.equal(vertex.vertexConfigError(), null);
});

test('reports a listed account with missing configuration as not ready', async () => {
  clearVertexEnv();
  const fixtureDir = mkdtempSync(join(tmpdir(), 'contentmachine-vertex-'));
  const mainCredentials = join(fixtureDir, 'main.json');
  writeFileSync(mainCredentials, '{}');

  process.env.USE_VERTEX_AI = 'true';
  process.env.VERTEX_IMAGE_ACCOUNTS = 'main,alt1';
  process.env.VERTEX_MAIN_PROJECT = 'main-project';
  process.env.VERTEX_MAIN_CREDENTIALS = mainCredentials;

  const vertex = await import(`./vertex.js?incomplete=${Date.now()}`);
  assert.equal(vertex.isVertexConfigured(), false);
  assert.equal(vertex.vertexAccountCount(), 1);
  assert.match(vertex.vertexConfigError(), /VERTEX_ALT1_PROJECT is required/);
});
