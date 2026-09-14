const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loader } = require('./load-ts.cjs');
const load = loader();
const { createContextHandoff, withHandoffArchive } = load(path.resolve(__dirname, '../src/lib/handoff.ts'));
const { readContext } = load(path.resolve(__dirname, '../src/lib/context-memory.ts'));

test('new window handoff is an unsent draft with requirements, evidence and uncertainties, without hidden reasoning', () => {
  const source = { id: 'old', title: '原任务', config: { model: 'model-a', runtime: { autoHandoff: true } }, projectId: 'p', keyProfileId: 'k' };
  const state = { runId: 'run', round: 4, at: 1, status: 'running', reasoning: 'PRIVATE_REASONING', stoppedBy: 'unknown',
    working: [{ id: 'goal', role: 'user', content: '保留完整的原始要求：A、B、C', attachments: [{ name: '资料', kind: 'text', text: 'FULL_ATTACHMENT' }] },
      { id: 'correction', role: 'user', content: '更正：不要再写入原文件。' }],
    steps: [{ id: 'done', callId: 'call', name: 'write_file', status: 'ok', summary: '已写入成果', resultRef: 'saved-output', files: [{ path: 'C:/result.txt', direction: 'output' }] }],
    pendingCalls: [{ id: 'pending', name: 'read_file' }], toolCursor: 0, uncertainCallId: 'uncertain',
    compactions: [{ facts: [{ text: '已核实事实', sources: ['goal'] }], unresolved: [{ text: 'B 尚待检查', sources: ['goal'] }], nextSteps: ['检查 C'] }],
  };
  const before = JSON.stringify({source,state});
  const draft = createContextHandoff(source, state, 'key');
  assert.equal(draft.messages.length, 0);
  for (const text of ['A、B、C', '不要再写入原文件', 'B 尚待检查', '检查 C', 'saved-output', 'uncertain', 'pending', 'read_context']) assert.ok(draft.draft.includes(text), text);
  assert.ok(!draft.draft.includes('PRIVATE_REASONING'));
  assert.equal(draft.handoffSourceRunId, 'run');
  assert.equal(draft.projectId, 'p');
  assert.notEqual(draft.config, source.config);
  assert.equal(JSON.stringify({source,state}), before);
});

test('handoff archives preserve full retrieval and never turn saved executions into new steps', () => {
  const source = { config: {model:'a'}, state: {working:[{id:'user',role:'user',content:'original',reasoning:'PRIVATE',attachments:[{kind:'text',text:'COMPLETE_SOURCE'}]}],steps:[{id:'step',callId:'call',resultRef:'evidence'}]} };
  const base = {history:[{id:'new',role:'user',content:'edited new request'}],archive:[],evidence:[],checkpoints:0};
  const result = withHandoffArchive(base, source);
  assert.deepEqual(result.history, base.history);
  assert.equal(result.evidence.length, 1);
  assert.ok(!JSON.stringify(result.archive).includes('PRIVATE'));
  const retrieved = readContext({working:result.history,contextArchive:result.archive},{id:'user'});
  assert.match(retrieved.content, /COMPLETE_SOURCE/);
  assert.equal(withHandoffArchive(result, source).archive.length, 1);
  assert.deepEqual(withHandoffArchive(base, undefined), base);
});
