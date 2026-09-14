const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loader } = require('./load-ts.cjs');
const load = loader();
const { classifyError } = load(path.resolve(__dirname, '../src/lib/errors.ts'));
const { endpoint } = load(path.resolve(__dirname, '../src/lib/api.ts'));

test('OpenRouter base URL resolves to the standard chat endpoint', () => {
  assert.equal(endpoint('https://openrouter.ai/api/v1/', 'chat/completions'), 'https://openrouter.ai/api/v1/chat/completions');
});

test('OpenRouter ZDR rejection preserves the real reason without blaming model identity', () => {
  const raw = '0 endpoints out of 3 requested are available matching your guardrail restrictions and data policy. ZDR violation (account settings): 3 endpoints excluded; configurable at https://openrouter.ai/settings/privacy';
  for (const status of [404, undefined]) {
    const result = classifyError(raw, status, { model: 'openrouter/free' });
    assert.equal(result.kind, 'routing_policy');
    assert.equal(result.detail, raw);
    assert.equal(result.blameModel, false);
    assert.equal(result.retryable, false);
  }
});

test('routing feature failures are distinguished from missing models and generic 404', () => {
  assert.match(classifyError('Stream ended before producing a non-ping SSE event (code STREAM_EARLY_EOF)',undefined).title,/网关连接已建立/);
  assert.equal(classifyError('No endpoints found that support image input', 404).kind, 'multimodal');
  assert.equal(classifyError('No endpoints found that support tool use', 404).kind, 'tools_unsupported');
  assert.equal(classifyError('No endpoints found for vendor/free', 404).kind, 'route_unavailable');
  assert.equal(classifyError('Unknown model', 404).kind, 'model_missing');
  assert.equal(classifyError('Not found', 404).kind, 'route_unavailable');
  assert.equal(classifyError('Rate limited', 429).kind, 'rate_limit');
  assert.equal(classifyError('Unauthorized', 401).kind, 'auth');
});
