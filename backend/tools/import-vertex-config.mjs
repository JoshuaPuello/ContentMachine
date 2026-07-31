#!/usr/bin/env node

// One-time migration helper for importing a Vertex account pool from any
// dotenv file. Runtime generation never reads the source application again.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseDotEnv } from 'dotenv';

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetEnvPath = join(backendDir, '.env');
const secretsDir = join(backendDir, '.secrets', 'vertex');
const sourceArg = process.argv[2];
const accountsFlagIndex = process.argv.indexOf('--accounts');
const requestedAccounts = accountsFlagIndex >= 0
  ? String(process.argv[accountsFlagIndex + 1] || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  : null;

if (!sourceArg) {
  console.error('Usage: npm run import:vertex -- /absolute/path/to/source.env [--accounts alt3,alt4]');
  process.exit(1);
}

const sourceEnvPath = resolve(process.cwd(), sourceArg);
if (!existsSync(sourceEnvPath)) {
  console.error(`Vertex source environment does not exist: ${sourceEnvPath}`);
  process.exit(1);
}

const source = parseDotEnv(readFileSync(sourceEnvPath));
const sourceAccountIds = (source.VERTEX_IMAGE_ACCOUNTS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const accountIds = requestedAccounts ?? sourceAccountIds;

if (accountIds.length === 0) {
  console.error('VERTEX_IMAGE_ACCOUNTS must list at least one account.');
  process.exit(1);
}
const sourceAccountSet = new Set(sourceAccountIds.map((id) => id.toLowerCase()));
const unavailableAccounts = accountIds.filter((id) => !sourceAccountSet.has(id.toLowerCase()));
if (unavailableAccounts.length > 0) {
  console.error(`Requested Vertex accounts are not listed by the source: ${unavailableAccounts.join(', ')}`);
  process.exit(1);
}

mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
chmodSync(secretsDir, 0o700);

const imported = {
  USE_VERTEX_AI: 'true',
  VERTEX_LOCATION: source.VERTEX_LOCATION || 'global',
  VERTEX_IMAGE_RPM: source.VERTEX_IMAGE_RPM || '2',
  VERTEX_IMAGE_ACCOUNTS: accountIds.join(','),
};
const managedKeys = new Set(['VERTEX_ENV_FILE', ...Object.keys(imported)]);
const currentTarget = existsSync(targetEnvPath)
  ? parseDotEnv(readFileSync(targetEnvPath))
  : {};
const currentAccountIds = (currentTarget.VERTEX_IMAGE_ACCOUNTS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
for (const managedAccountId of new Set([...sourceAccountIds, ...currentAccountIds])) {
  const token = managedAccountId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const prefix = `VERTEX_${token}`;
  managedKeys.add(`${prefix}_PROJECT`);
  managedKeys.add(`${prefix}_CREDENTIALS`);
  managedKeys.add(`${prefix}_CREDENTIALS_JSON`);
  managedKeys.add(`${prefix}_LOCATION`);
  managedKeys.add(`${prefix}_IMAGE_RPM`);
}

for (const accountId of accountIds) {
  const token = accountId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const prefix = `VERTEX_${token}`;
  const projectId = source[`${prefix}_PROJECT`];
  const sourceCredentialsValue = source[`${prefix}_CREDENTIALS`];
  if (!projectId || !sourceCredentialsValue) {
    console.error(`${prefix}_PROJECT and ${prefix}_CREDENTIALS are required.`);
    process.exit(1);
  }

  const sourceCredentials = isAbsolute(sourceCredentialsValue)
    ? sourceCredentialsValue
    : resolve(dirname(sourceEnvPath), sourceCredentialsValue);
  if (!existsSync(sourceCredentials)) {
    console.error(`${prefix}_CREDENTIALS points to a missing file.`);
    process.exit(1);
  }

  try {
    const credentials = JSON.parse(readFileSync(sourceCredentials, 'utf8'));
    const serviceAccountValid = credentials.type === 'service_account'
      && credentials.client_email
      && credentials.private_key;
    const authorizedUserValid = credentials.type === 'authorized_user'
      && credentials.client_id
      && credentials.client_secret
      && credentials.refresh_token;
    if (!serviceAccountValid && !authorizedUserValid) throw new Error('unsupported Google credential shape');
  } catch {
    console.error(`${prefix}_CREDENTIALS is not a supported Google credential JSON file.`);
    process.exit(1);
  }

  const localName = `${accountId.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
  const localCredentials = join(secretsDir, localName);
  copyFileSync(sourceCredentials, localCredentials);
  chmodSync(localCredentials, 0o600);

  imported[`${prefix}_PROJECT`] = projectId;
  imported[`${prefix}_CREDENTIALS`] = `.secrets/vertex/${localName}`;
  imported[`${prefix}_LOCATION`] = source[`${prefix}_LOCATION`] || source.VERTEX_LOCATION || 'global';
  imported[`${prefix}_IMAGE_RPM`] = source[`${prefix}_IMAGE_RPM`] || source.VERTEX_IMAGE_RPM || '2';
  managedKeys.add(`${prefix}_PROJECT`);
  managedKeys.add(`${prefix}_CREDENTIALS`);
  managedKeys.add(`${prefix}_CREDENTIALS_JSON`);
  managedKeys.add(`${prefix}_LOCATION`);
  managedKeys.add(`${prefix}_IMAGE_RPM`);
}

const currentLines = existsSync(targetEnvPath)
  ? readFileSync(targetEnvPath, 'utf8').split(/\r?\n/)
  : [];
const preservedLines = currentLines.filter((line) => {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
  if (!match) return true;
  const key = match[1];
  const isAccountField = /^VERTEX_(?!IMAGE_RPM$|IMAGE_ACCOUNTS$|LOCATION$)[A-Z0-9_]+_(?:PROJECT|CREDENTIALS|CREDENTIALS_JSON|LOCATION|IMAGE_RPM)$/.test(key);
  return !managedKeys.has(key) && !isAccountField;
});
while (preservedLines.at(-1)?.trim() === '') preservedLines.pop();

const output = [
  ...preservedLines,
  '',
  '# ContentMachine-owned Vertex account pool',
  ...Object.entries(imported).map(([key, value]) => `${key}=${value}`),
  '',
].join('\n');
const temporaryEnvPath = `${targetEnvPath}.vertex-import`;
writeFileSync(temporaryEnvPath, output, { mode: 0o600 });
renameSync(temporaryEnvPath, targetEnvPath);
chmodSync(targetEnvPath, 0o600);

console.log(`Imported ${accountIds.length} Vertex accounts into ContentMachine.`);
console.log('Credential files are local, private, and excluded by .gitignore.');
