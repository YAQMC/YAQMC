import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(
  readFileSync(path.join(root, 'wit/yaqmc-provider/protocol-v0.1.json'), 'utf8'),
);
const providerSource = readFileSync(
  path.join(root, 'crates/yaqmc-core/src/plugin/provider.rs'),
  'utf8',
);
const wit = readFileSync(path.join(root, 'wit/yaqmc-provider/yaqmc-provider.wit'), 'utf8');

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

test('frozen Provider Component operations cover every Core dispatch', () => {
  const sourceOperations = sortedUnique(
    [
      ...providerSource.matchAll(
        /"((?:account|catalog|lyrics|playback|recommendation)\.[a-z0-9.-]+)"/gu,
      ),
    ].map((match) => match[1]),
  );
  const fixtureOperations = sortedUnique(
    Object.values(fixture.capabilities).flatMap((capability) => capability.operations),
  );

  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.witPackage, 'yaqmc:provider@0.1.0');
  assert.deepEqual(fixtureOperations, sourceOperations);
  for (const [capability, contract] of Object.entries(fixture.capabilities)) {
    assert.deepEqual(contract.operations, contract.operations.slice().sort());
    assert.ok(contract.operations.every((operation) => operation.startsWith(capability.slice(9))));
  }
});

test('frozen world imports match the checked-in WIT contract', () => {
  for (const [world, imports] of Object.entries(fixture.worlds)) {
    const block = new RegExp(`world ${world} \\{([\\s\\S]*?)\\n\\}`, 'u').exec(wit)?.[1];
    assert.ok(block, `missing WIT world ${world}`);
    const actualImports = sortedUnique(
      [...block.matchAll(/import ([a-z-]+);/gu)].map((match) => match[1]),
    );
    assert.deepEqual(actualImports, imports.slice().sort());
    assert.match(block, /export invoke: func\(/u);
  }
});

test('golden envelopes cover every v3 capability without exposing transport secrets', () => {
  const sampledOperations = fixture.sampleInvocations.map(({ request }) => request.operation);
  assert.deepEqual(sampledOperations, [
    'catalog.discover',
    'playback.resolve',
    'recommendation.next',
    'lyrics.get',
    'account.snapshot',
  ]);
  assert.deepEqual(
    fixture.sampleInvocations.map(({ request }) => request.capability),
    Object.keys(fixture.capabilities),
  );
  assert.deepEqual(
    fixture.hostLifecycle.map(({ event }) => event),
    ['provider-disabled', 'provider-re-enabled', 'account-generation-changed'],
  );
  assert.deepEqual(fixture.sampleErrors[0].error, {
    code: 'permission-denied',
    message: 'the provider capability is not granted',
    retryable: false,
  });
  const serialized = JSON.stringify({
    samples: fixture.sampleInvocations,
    errors: fixture.sampleErrors,
  });
  assert.doesNotMatch(
    serialized,
    /signedUrl|authorization|cookie|credentialValue|filesystemPath/iu,
  );
  const playback = fixture.sampleInvocations[1].response;
  assert.deepEqual(playback.source, { kind: 'cache', key: 'example-audio-v1' });
});

test('renderer IPC and local OpenAPI retain provider identity without exposing Component internals', () => {
  const ipcMethods = JSON.parse(
    readFileSync(path.join(root, 'packages/yaqmc-client/fixtures/methods.json'), 'utf8'),
  ).map((method) => method.name);
  for (const method of [
    'provider_list',
    'provider_search',
    'provider_recommendation_next',
    'provider_lyrics',
    'provider_account_login_methods',
    'provider_auth_oauth_start',
  ]) {
    assert.ok(ipcMethods.includes(method), `missing renderer method ${method}`);
  }
  const openapi = readFileSync(path.join(root, 'docs/local-api.openapi.yaml'), 'utf8');
  assert.match(openapi, /ProviderTrackReference:[\s\S]*providerId:/u);
  assert.doesNotMatch(openapi, /credential-handle|payload-json|signedUrl/iu);
});
