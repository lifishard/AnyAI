const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loader } = require('./load-ts.cjs');

const api = loader()(path.join(__dirname, '..', 'src', 'lib', 'user-questions.ts'));

function request() {
  return api.parseUserQuestions(
    {
      questions: [
        {
          id: 'q-one',
          header: '偏好',
          question: '  你更喜欢哪一种？  ',
          options: [
            { label: '  快速  ', description: '  先给结论  ' },
            { label: '完整', description: '附带步骤' },
          ],
        },
        { id: 'q-two', question: '补充说明', options: [], multiple: false },
      ],
    },
    '  req-1  ',
    123,
  );
}

test('parser trims and bounds fields while retaining text-only questions', () => {
  const parsed = api.parseUserQuestions(
    {
      questions: [
        {
          id: ` q-${'x'.repeat(300)} `,
          header: ` ${'h'.repeat(300)} `,
          question: ` ${'q'.repeat(5000)} `,
          options: [{ label: ` ${'l'.repeat(700)} `, description: ` ${'d'.repeat(1200)} ` }],
        },
        { id: 'free', question: '  自由回答  ', options: [] },
      ],
    },
    ' req ',
    0,
  );
  assert.equal(parsed.id, 'req');
  assert.equal(parsed.createdAt, 0);
  assert.equal(parsed.questions[1].options.length, 0);
  assert.equal(parsed.questions[0].id.length, api.USER_QUESTION_LIMITS.questionId);
  assert.equal(parsed.questions[0].header.length, api.USER_QUESTION_LIMITS.header);
  assert.equal(parsed.questions[0].question.length, api.USER_QUESTION_LIMITS.question);
  assert.equal(parsed.questions[0].options[0].label.length, api.USER_QUESTION_LIMITS.optionLabel);
  assert.equal(parsed.questions[0].options[0].description.length, api.USER_QUESTION_LIMITS.optionDescription);
});

test('parser enforces question and option bounds and unique ids', () => {
  assert.throws(() => api.parseUserQuestions({ questions: [] }, 'r'), /1到3/);
  assert.throws(
    () => api.parseUserQuestions({ questions: Array.from({ length: 4 }, (_, i) => ({ id: `q${i}`, question: 'x', options: [] })) }, 'r'),
    /1到3/,
  );
  assert.throws(
    () => api.parseUserQuestions({ questions: [{ id: 'q', question: 'x', options: [] }, { id: 'q', question: 'y', options: [] }] }, 'r'),
    /重复/,
  );
  assert.throws(
    () => api.parseUserQuestions({ questions: [{ id: 'q', question: 'x', options: Array.from({ length: 7 }, (_, i) => ({ label: String(i) })) }] }, 'r'),
    /不能超过6/,
  );
});

test('answer validation trims labels, accepts custom text, and requires every question', () => {
  const normalized = api.validateUserAnswers(request(), {
    'q-one': { selected: ['  快速  '], text: '  可选说明  ' },
    'q-two': { selected: [], text: '  需要保留的补充内容\n第二行  ' },
  });
  assert.deepEqual(normalized, {
    'q-one': { selected: ['快速'], text: '可选说明' },
    'q-two': { selected: [], text: '需要保留的补充内容\n第二行' },
  });
  assert.throws(() => api.validateUserAnswers(request(), { 'q-one': { selected: ['快速'], text: '' } }), /q-two|第2题/);
  assert.throws(() => api.validateUserAnswers(request(), { 'q-one': { selected: [], text: '' }, 'q-two': { selected: [], text: '' } }), /需要选择或填写/);
});

test('answer validation rejects unknown ids, options, duplicates, and multi-select for single choice', () => {
  const base = request();
  assert.throws(
    () => api.validateUserAnswers(base, { ...{ 'q-one': { selected: ['快速'], text: '' }, 'q-two': { selected: [], text: 'ok' } }, unknown: { selected: [], text: 'x' } }),
    /未知问题/,
  );
  assert.throws(
    () => api.validateUserAnswers(base, { 'q-one': { selected: ['未知'], text: '' }, 'q-two': { selected: [], text: 'ok' } }),
    /未知选项/,
  );
  assert.throws(
    () => api.validateUserAnswers(base, { 'q-one': { selected: ['快速', '完整'], text: '' }, 'q-two': { selected: [], text: 'ok' } }),
    /只能选择一个/,
  );
  assert.throws(
    () => api.validateUserAnswers(base, { 'q-one': { selected: ['快速', '快速'], text: '' }, 'q-two': { selected: [], text: 'ok' } }),
    /选项无效/,
  );
});

test('formatting preserves multiline questions and custom answers without inventing values', () => {
  const value = api.formatUserAnswers(request(), {
    'q-one': { selected: ['完整'], text: '' },
    'q-two': { selected: [], text: '第一行\n第二行' },
  });
  assert.match(value, /问题回答/);
  assert.match(value, /偏好/);
  assert.match(value, /你更喜欢哪一种/);
  assert.match(value, /选择：完整/);
  assert.match(value, /补充说明/);
  assert.match(value, /第一行\n第二行/);
  assert.doesNotMatch(value, /快速/);
  assert.doesNotMatch(value, /没有提供/);
});

test('agent pauses at request_user_input and resumes the same cursor once with the exact formatted answer', async () => {
  const root = path.resolve(__dirname, '..');
  const file = (name) => path.join(root, name);
  let phase = 'question';
  let sentBody;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const transport = {
    chat: async (init, events) => {
      sentBody = init.body;
      if (phase === 'question') {
        events.onToolCalls([{ id: 'ask-1', name: 'request_user_input', arguments: JSON.stringify({
          questions: [{ id: 'choice', question: '请选择', options: [{ label: '保留' }, { label: '调整' }] }],
        }) }]);
        events.onStop({ reason: 'tool_calls', droppedCalls: 0 });
      } else {
        events.onContent('继续完成');
        events.onToolCalls([]);
        events.onStop({ reason: 'stop', droppedCalls: 0 });
      }
      events.onUsage({ total_tokens: 3 });
      events.onDone();
    },
    callTool: async () => ({ ok: true, content: '' }),
    abort: async () => {},
  };
  let serial = 0;
  const local = loader({
    [file('src/lib/transport.ts')]: { getTransport: () => transport },
    [file('src/lib/store.ts')]: { uid: () => `question-${++serial}` },
  });
  const cfg = local(file('src/lib/paramSchema.ts')).defaultGenerationConfig();
  Object.assign(cfg, {
    model: 'mock',
    toolsEnabled: false,
    enabledTools: [],
    maxToolRounds: 3,
    runtime: { contextTokens: 50000, maxMinutes: 1, maxTokens: 100000 },
  });
  const states = [];
  const log = { paused: 0, done: 0 };
  const args = {
    requestId: 'question-run',
    profile: { id: 'test', baseUrl: 'http://localhost/v1', name: 'test', hasSecret: false, extraHeaders: {}, createdAt: 0 },
    apiKey: 'test-only',
    config: cfg,
    history: [{ id: 'user', role: 'user', content: '完成这个任务', createdAt: 1 }],
    toolCtx: () => ({ workspaceRoots: [] }),
    effortMappings: [],
    extraSystem: '',
    timeoutMs: 1000,
    canRunHostTools: false,
    autoRetry: 0,
    confirm: async () => true,
    grantAccess: async () => ({ ok: true, content: '' }),
    events: {
      onContentDelta() {}, onReasoningDelta() {}, onSources() {}, onUsage() {}, onRound() {}, onNotice() {}, onStopReason() {},
      onStep() {},
      onRunState: (state) => { if (state) states.push(structuredClone(state)); },
      onPaused: () => { log.paused++; if (phase === 'question') finish(); },
      onDone: () => { log.done++; finish(); },
      onError: (message) => { throw new Error(message); },
    },
  };
  local(file('src/lib/agent.ts')).runAgent(args);
  await finished;
  const paused = states.at(-1);
  assert.equal(log.paused, 1);
  assert.equal(paused.waitKind, 'question');
  assert.equal(paused.userQuestion.request.questions[0].id, 'choice');
  assert.match(JSON.stringify(sentBody), /request_user_input/);

  phase = 'resume';
  let resumed;
  const resumedFinished = new Promise((resolve) => { resumed = resolve; });
  args.events.onRunState = (state) => { if (state) states.push(structuredClone(state)); };
  args.events.onPaused = () => { throw new Error('answer should not pause'); };
  args.events.onDone = () => { log.done++; resumed(); };
  const answerState = structuredClone(paused);
  answerState.userQuestion.answers = { choice: { selected: ['保留'], text: '' } };
  local(file('src/lib/agent.ts')).runAgent({ ...args, requestId: 'question-resume', resume: answerState });
  await resumedFinished;
  assert.equal(log.done, 1);
  const completed = states.at(-1);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.userQuestion, undefined);
  assert.equal(completed.userQuestionHistory[0].answers.choice.selected[0], '保留');
  assert.match(JSON.stringify(completed.working), /选择：保留/);
});
