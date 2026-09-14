/**
 * Structured questions that can pause a Chat or Work turn until the user
 * supplies a choice or a free-form answer.
 *
 * This module deliberately has no runtime or storage dependencies.  The
 * caller owns when a request is created, persisted, resumed, and submitted.
 */

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options: UserQuestionOption[];
  multiple?: boolean;
}

export interface UserQuestionRequest {
  id: string;
  questions: UserQuestion[];
  createdAt: number;
}

export interface UserQuestionAnswer {
  selected: string[];
  text: string;
}

export type UserQuestionAnswers = Record<string, UserQuestionAnswer>;

/** A completed question request retained in the local task transcript. */
export interface UserQuestionHistoryItem {
  request: UserQuestionRequest;
  answers: UserQuestionAnswers;
  at: number;
}

/** Public so the UI can use the same bounds as the parser and validator. */
export const USER_QUESTION_LIMITS = Object.freeze({
  requestId: 128,
  questionId: 128,
  header: 160,
  question: 4000,
  optionLabel: 500,
  optionDescription: 1000,
  answerText: 12000,
});

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Trim surrounding whitespace and cap untrusted model/user text. */
function cleanRequired(value: unknown, max: number, message: string): string {
  if (typeof value !== 'string') fail(message);
  const result = value.trim().slice(0, max).trim();
  if (!result) fail(message);
  return result;
}

function cleanOptional(value: unknown, max: number, message: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(message);
  const result = value.trim().slice(0, max).trim();
  return result || undefined;
}

function answerText(value: unknown): string {
  if (typeof value !== 'string') fail('补充回答格式无效');
  return value.trim().slice(0, USER_QUESTION_LIMITS.answerText).trim();
}

function questionName(question: UserQuestion, index: number): string {
  return question.header?.trim() || `第${index + 1}题`;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Parse and normalize the model-facing question payload.
 *
 * The parser accepts exactly the useful shape `{ questions: [...] }` and
 * returns a small, bounded object that is safe to retain locally.  Empty
 * `options` means the question is answered with free text only.
 */
export function parseUserQuestions(
  raw: unknown,
  id: string,
  createdAt: number = Date.now(),
): UserQuestionRequest {
  const requestId = cleanRequired(id, USER_QUESTION_LIMITS.requestId, '问题请求标识无效');
  if (!Number.isFinite(createdAt) || createdAt < 0) fail('创建时间无效');
  if (!isRecord(raw) || !Array.isArray(raw.questions)) fail('问题请求格式无效');
  if (raw.questions.length < 1 || raw.questions.length > 3) fail('问题数量应为1到3个');

  const seenQuestionIds = new Set<string>();
  const questions: UserQuestion[] = raw.questions.map((value, index) => {
    if (!isRecord(value)) fail(`第${index + 1}题格式无效`);

    const questionId = cleanRequired(
      value.id,
      USER_QUESTION_LIMITS.questionId,
      `第${index + 1}题标识无效`,
    );
    if (seenQuestionIds.has(questionId)) fail('问题标识重复');
    seenQuestionIds.add(questionId);

    const question = cleanRequired(
      value.question,
      USER_QUESTION_LIMITS.question,
      `第${index + 1}题内容不能为空`,
    );
    const header = cleanOptional(value.header, USER_QUESTION_LIMITS.header, '题目标头无效');
    if (!Array.isArray(value.options)) fail(`第${index + 1}题选项格式无效`);
    if (value.options.length > 6) fail('选项数量不能超过6个');
    if (value.multiple !== undefined && typeof value.multiple !== 'boolean') {
      fail(`第${index + 1}题多选设置无效`);
    }

    const seenLabels = new Set<string>();
    const options: UserQuestionOption[] = value.options.map((optionValue, optionIndex) => {
      if (!isRecord(optionValue)) fail(`第${index + 1}题第${optionIndex + 1}个选项无效`);
      const label = cleanRequired(
        optionValue.label,
        USER_QUESTION_LIMITS.optionLabel,
        `第${index + 1}题选项内容不能为空`,
      );
      if (seenLabels.has(label)) fail(`第${index + 1}题选项不能重复`);
      seenLabels.add(label);
      const description = cleanOptional(
        optionValue.description,
        USER_QUESTION_LIMITS.optionDescription,
        `第${index + 1}题选项说明无效`,
      );
      return description === undefined ? { label } : { label, description };
    });

    return {
      id: questionId,
      ...(header === undefined ? {} : { header }),
      question,
      options,
      ...(value.multiple === true ? { multiple: true } : {}),
    };
  });

  return { id: requestId, questions, createdAt };
}

/**
 * Validate and normalize submitted answers.  Selection values are option
 * labels because options intentionally have no second identifier in the
 * public contract.
 */
export function validateUserAnswers(
  request: UserQuestionRequest,
  answers: UserQuestionAnswers,
): UserQuestionAnswers {
  if (!isRecord(request) || !Array.isArray(request.questions) || request.questions.length < 1) {
    fail('问题请求无效');
  }
  if (!isRecord(answers)) fail('回答格式无效');

  const questionIds = new Set<string>();
  for (const question of request.questions) {
    if (!isRecord(question) || typeof question.id !== 'string' || questionIds.has(question.id)) {
      fail('问题标识无效');
    }
    questionIds.add(question.id);
  }
  for (const answerId of Object.keys(answers)) {
    if (!questionIds.has(answerId)) fail('回答包含未知问题');
  }

  const normalized: UserQuestionAnswers = {};
  request.questions.forEach((question, index) => {
    const id = question.id;
    if (!hasOwn(answers, id)) fail(`${questionName(question, index)}尚未回答`);
    const rawAnswer = answers[id];
    if (!isRecord(rawAnswer)) fail(`${questionName(question, index)}回答格式无效`);
    if (!Array.isArray(rawAnswer.selected)) fail(`${questionName(question, index)}选项格式无效`);
    if (!Array.isArray(question.options)) fail('问题选项无效');

    const labels = new Set(question.options.map((option) => option.label));
    const selected: string[] = [];
    const selectedSet = new Set<string>();
    for (const rawLabel of rawAnswer.selected) {
      if (typeof rawLabel !== 'string') fail(`${questionName(question, index)}选项无效`);
      const label = rawLabel.trim();
      if (!label || selectedSet.has(label)) fail(`${questionName(question, index)}选项无效`);
      if (!labels.has(label)) fail(`${questionName(question, index)}包含未知选项`);
      selectedSet.add(label);
      selected.push(label);
    }
    if (!question.multiple && selected.length > 1) {
      fail(`${questionName(question, index)}只能选择一个选项`);
    }

    const text = answerText(rawAnswer.text);
    if (!selected.length && !text) fail(`${questionName(question, index)}需要选择或填写回答`);
    normalized[id] = { selected, text };
  });

  return normalized;
}

/** Format only the answers that the user actually supplied. */
export function formatUserAnswers(
  request: UserQuestionRequest,
  answers: UserQuestionAnswers,
): string {
  const normalized = validateUserAnswers(request, answers);
  const sections = request.questions.map((question, index) => {
    const answer = normalized[question.id];
    const lines = [`${index + 1}. ${question.header ? `${question.header}\n` : ''}${question.question}`];
    if (answer.selected.length) lines.push(`选择：${answer.selected.join('、')}`);
    if (answer.text) lines.push(`补充回答：${answer.text}`);
    return lines.join('\n');
  });
  return ['问题回答：', ...sections].join('\n\n');
}
