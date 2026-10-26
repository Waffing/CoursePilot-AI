const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const original = fs.readFileSync(path.resolve(__dirname, '../upstream/greasyfork-488083.original.user.js'), 'utf8');
const modified = fs.readFileSync(path.resolve(__dirname, '../scripts/coursepilot-ai.user.js'), 'utf8');
const keyStorage = 'greasyfork-488083-model-api-key';
const plain = (value) => JSON.parse(JSON.stringify(value));
const question = {
  title: 'Which option?', type: '0', optionsText: ['A. Alpha', 'B. Beta'],
  searchText: { stem: 'Which option?', options: ['Alpha', 'Beta'] }
};
const completion = (answers, extra = {}) => ({
  choices: [{ message: { content: JSON.stringify({ answerable: true, answers, ...extra }) } }]
});
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Source section exists: ${start}`);
  return source.slice(first, last);
}
function createHarness(storageSeed = {}) {
  const storage = new Map(Object.entries(storageSeed));
  const local = new Map();
  const requests = [];
  const logs = [];
  const stores = new Map();
  const sandbox = {
    URL, AbortController, console,
    document: {}, _unsafeWindow: {},
    __publicField: (object, key, value) => { object[key] = value; },
    getScriptInfo: () => ({ version: '0.2.8.1' }),
    VIDEO_QUIZ_SETTING: '\u89c6\u9891\u5f39\u9898\u81ea\u52a8\u5904\u7406',
    localStorage: { getItem: (key) => local.get(key), setItem: (key, value) => local.set(key, value) },
    _GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    _GM_setValue: (key, value) => storage.set(key, value),
    vue: { reactive: (value) => value },
    useLogStore: () => ({ addLog: (message) => logs.push(message) }),
    useQuestionStore: () => ({ addQuestion() {} }),
    sleep: async () => {},
    _GM_xmlhttpRequest: (options) => {
      const request = { options, aborted: false, abort() { this.aborted = true; options.onabort(); } };
      requests.push(request);
      if (sandbox.autoReply) queueMicrotask(() => sandbox.autoReply(options));
      return request;
    },
    pinia: { defineStore(name, definition) {
      return () => {
        if (!stores.has(name)) stores.set(name, definition.state());
        return stores.get(name);
      };
    } }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext([
    section(modified, '  const MODEL_API_KEY_STORAGE_KEY', '  function extractRawTextFromElement'),
    section(modified, '  function stripOptionLabel', '  function stripQuestionTypeLabel'),
    section(modified, '  const CONFIG_STORAGE_KEY', '  const formatDateTime'),
    section(modified, '  const getAnswer =', '  const toAnnouncementItems'),
    section(modified, '  class BaseQuestionHandler', '  const useCxChapterLogic'),
    'globalThis.api = { getModelEndpoint, buildModelMessages, parseModelResponse, getAnswerValues, getAnswer, persistConfig, getConfig: useConfigStore, CxQuestionHandler, getModelHeaders, buildModelRequest, fetchModelList, searchWithTavily, getNativeSearchInfo, switchModelProvider, MODEL_PROVIDERS };'
  ].join('\n'), context, { timeout: 1000 });
  const api = sandbox.api;
  return { api, sandbox, storage, local, requests, logs, context };
}
function configured() {
  const harness = createHarness();
  Object.assign(harness.api.getConfig().queryApis[0], {
    url: 'https://model.example/v1', model: 'test-model', token: 'TEST_KEY_NOT_A_SECRET'
  });
  return harness;
}

test('original file is unchanged', () => {
  assert.equal(crypto.createHash('sha256').update(original).digest('hex').toUpperCase(),
    'BE4DA1E080E74B9269C189CA67E48F2DFCD20D3E7FE279461AE1EC386291D1F8');
});

test('playback, chapter submission, exams, routing and hooks are preserved', () => {
  for (const [start, end] of [
    ['  const useCxChapterLogic', '  class ZhsQuestionHandler'],
    ['  const hookError', '  const DEFAULT_CARD_WIDTH'],
    ['  const DEFAULT_CARD_WIDTH', '  const _sfc_main$2'],
    ['  const _sfc_main$2', '  const _sfc_main ='],
    ['  const _sfc_main =', '})(Vue, Pinia, rxjs, md5, ElementPlus);']
  ]) assert.equal(section(modified, start, end).replace('      createStyleSheet(layoutCss),\n      createStyleSheet(modelSettingsCss)\n', '      createStyleSheet(layoutCss)\n'), section(original, start, end));
  for (const [start, end] of [
    ['  class CxQuestionHandler', '  const useCxChapterLogic'],
    ['  class ZhsQuestionHandler', '  const hookError']
  ]) {
    const normalize = (value) => value
      .replace(/            question\.searchInfo = answerData\.meta\?\.search \|\| null;\n/g, '')
      .replace(/var _a, _b;/g, 'var _b;')
      .replace(/var _a, _b, _c, _d;/g, 'var _b, _c, _d;')
      .replace(/this\.addLog\(`\u5269\u4f59\u6b21\u6570:[^\n]+\n/g, '')
      .replace(/this\.addLog\("\u6a21\u578b\u7b54\u6848\u5df2\u8fd4\u56de", "primary"\);\n/g, '');
    assert.equal(normalize(section(modified, start, end)), normalize(section(original, start, end)));
  }
});

test('model endpoint supports origin, versioned base, gateway prefix and full path', () => {
  const { api } = createHarness();
  for (const [input, expected] of [
    ['https://model.example', 'https://model.example/v1/chat/completions'],
    ['https://model.example/v1/', 'https://model.example/v1/chat/completions'],
    ['https://model.example/gateway/v2', 'https://model.example/gateway/v2/chat/completions'],
    ['https://model.example/v1/chat/completions', 'https://model.example/v1/chat/completions'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions']
  ]) assert.equal(api.getModelEndpoint(input), expected);
});

test('endpoint rejects unsafe remote HTTP and embedded credentials or query parameters', () => {
  const { api } = createHarness();
  for (const address of ['http://model.example/v1', 'https://user:pass@model.example', 'https://model.example?key=x', 'https://model.example#fragment', 'not-a-url'])
    assert.throws(() => api.getModelEndpoint(address));
});

test('single-choice index maps to the original option text and response contract', () => {
  const { api } = createHarness();
  const response = api.parseModelResponse(completion([2]), 200, question);
  assert.deepEqual(plain(api.getAnswerValues(response, question)), ['B. Beta']);
  assert.equal(response.data.items[0].stem, question.searchText.stem);
});

test('multiple-choice letters, numbers and exact text map to original options', () => {
  const { api } = createHarness();
  for (const answers of [[1, 2], ['A', 'B'], ['Alpha', 'Beta']]) {
    const response = api.parseModelResponse(completion(answers), 200, { ...question, type: '1' });
    assert.deepEqual(plain(api.getAnswerValues(response, question)), ['A. Alpha', 'B. Beta']);
  }
});

test('invalid choice indices, duplicate choices and multiple single-choice answers fail', () => {
  const { api } = createHarness();
  for (const [answers, type] of [[[0], '0'], [[3], '0'], [['unknown'], '0'], [[1, 2], '0'], [[1, 1], '1'], [[{}], '0']])
    assert.equal(api.parseModelResponse(completion(answers), 200, { ...question, type }).success, false);
});

test('boolean answers normalize to the words required by existing judgement handlers', () => {
  const { api } = createHarness();
  for (const type of ['3', '\u5224\u65ad\u9898']) {
    for (const [input, expected] of [[true, '\u6b63\u786e'], [false, '\u9519\u8bef'], ['\u5bf9', '\u6b63\u786e'], ['\u9519', '\u9519\u8bef']]) {
      const result = api.parseModelResponse(completion([input]), 200, { ...question, type });
      assert.deepEqual(plain(api.getAnswerValues(result, question)), [expected]);
    }
  }
});

test('fill-in answers preserve order, including repeated text and zero', () => {
  const { api } = createHarness();
  const response = api.parseModelResponse(completion(['same', 'same', 0]), 200, { ...question, type: '2' });
  assert.deepEqual(plain(api.getAnswerValues(response, question)), ['same', 'same', '0']);
});

test('short answers, JSON fences and text content arrays are supported', () => {
  const { api } = createHarness();
  const payload = { choices: [{ message: { content: [{ type: 'text', text: '```json\n{"answerable":true,"answers":["Short answer"]}\n```' }] } }] };
  assert.deepEqual(plain(api.getAnswerValues(api.parseModelResponse(payload, 200, { ...question, type: '4' }), question)), ['Short answer']);
});

test('unanswerable, malformed, refused and empty responses do not become answers', () => {
  const { api } = createHarness();
  for (const payload of [
    completion([], { answerable: false }), completion(['']), completion([{}]),
    { choices: [{ message: { content: 'not JSON' } }] },
    { choices: [{ message: { content: '', refusal: 'refused' } }] },
    { choices: [] }, null
  ]) assert.equal(api.parseModelResponse(payload, 200, { ...question, type: '4' }).success, false);
});

test('HTTP errors are classified without rendering provider-controlled HTML', () => {
  const { api } = createHarness();
  for (const status of [401, 403, 404, 429, 500]) {
    const result = api.parseModelResponse({ error: { message: '<img onerror=bad()>' } }, status, question);
    assert.equal(result.success, false);
    assert.equal(result.error.code, `HTTP_${status}`);
    assert(!result.error.message.includes('<img'));
  }
});

test('old question-bank configuration keeps existing settings and clears old credentials', () => {
  const oldConfig = { queryApis: [{ name: '\u9898\u5e93', url: 'https://search.tikuhai.com', token: 'OLD_TEST_TOKEN' }], position: { x: '111px', y: '222px' } };
  const { api } = createHarness({ config: JSON.stringify(oldConfig) });
  const config = api.getConfig();
  assert.equal(config.position.x, '111px');
  assert.equal(config.queryApis[0].url, '');
  assert.equal(config.queryApis[0].token, '');
  assert.equal(config.queryApis[0].model, '');
});

test('API key persists in GM storage only and model settings survive reloading', () => {
  const h = configured();
  h.api.persistConfig(h.api.getConfig());
  assert.equal(h.storage.get(keyStorage), 'TEST_KEY_NOT_A_SECRET');
  for (const serialized of [h.storage.get('config'), h.storage.get('globalConfig'), h.local.get('config')])
    assert(!serialized.includes('TEST_KEY_NOT_A_SECRET'));
  const restored = createHarness(Object.fromEntries(h.storage)).api.getConfig().queryApis[0];
  assert.equal(restored.url, 'https://model.example/v1');
  assert.equal(restored.model, 'test-model');
  assert.equal(restored.token, 'TEST_KEY_NOT_A_SECRET');
});

test('model configuration is required before any network request', async () => {
  const h = createHarness();
  const result = await h.api.getAnswer(question);
  assert.equal(result.success, false);
  assert.equal(h.requests.length, 0);
});

test('request uses the selected model, Bearer auth and the legacy result contract', async () => {
  const h = configured();
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(completion([2])) });
  const result = await h.api.getAnswer(question, { skipDelay: true });
  const request = h.requests[0].options;
  const body = JSON.parse(request.data);
  assert.equal(request.url, 'https://model.example/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer TEST_KEY_NOT_A_SECRET');
  assert.equal(request.headers['X-Consumer-Token'], undefined);
  assert.equal(request.anonymous, true);
  assert.equal(request.timeout, 120000);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.deepEqual(JSON.parse(body.messages[1].content).options, [{ index: 1, text: 'Alpha' }, { index: 2, text: 'Beta' }]);
  assert.deepEqual(plain(h.api.getAnswerValues(result, question)), ['B. Beta']);
});

test('local services work without an API key', async () => {
  const h = configured();
  Object.assign(h.api.getConfig().queryApis[0], { url: 'http://127.0.0.1:11434/v1', token: '' });
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(completion([1])) });
  assert.equal((await h.api.getAnswer(question, { skipDelay: true })).success, true);
  assert.equal(h.requests[0].options.headers.Authorization, undefined);
});

test('network errors, timeout, invalid JSON and non-JSON HTTP errors are handled', async () => {
  for (const event of ['onerror', 'ontimeout', 'invalid-json', 'http-error']) {
    const h = configured();
    h.sandbox.autoReply = (options) => {
      if (event === 'invalid-json') options.onload({ status: 200, responseText: '<html>invalid</html>' });
      else if (event === 'http-error') options.onload({ status: 401, responseText: '<html>error</html>' });
      else options[event]();
    };
    const result = await h.api.getAnswer(question, { skipDelay: true });
    assert.equal(result.success, false);
    if (event === 'http-error') assert.equal(result.error.code, 'HTTP_401');
  }
});

test('aborted requests and late responses cannot publish an answer', async () => {
  const h = configured();
  const controller = new AbortController();
  const pending = h.api.getAnswer(question, { signal: controller.signal, skipDelay: true });
  assert.equal(h.requests.length, 1);
  controller.abort();
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(h.requests[0].aborted, true);
  h.requests[0].options.onload({ status: 200, responseText: JSON.stringify(completion([2])) });
  assert.equal(result.success, false);
});

test('a page change while a model request is pending discards its answer', async () => {
  const h = configured();
  let current = true;
  const pending = h.api.getAnswer(question, { isCurrent: () => current, skipDelay: true });
  current = false;
  h.requests[0].options.onload({ status: 200, responseText: JSON.stringify(completion([2])) });
  assert.equal((await pending).success, false);
});

test('a model answer flows through the original question handler and selects the option', async () => {
  const h = configured();
  let clicks = 0;
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(completion([2])) });
  const handler = new h.api.CxQuestionHandler('zj');
  handler.parseHtml = () => { handler.questions = [{ ...question, options: {
    'A. Alpha': { getAttribute() { return null; }, click() { throw new Error('Wrong option clicked'); } },
    'B. Beta': { getAttribute() { return null; }, click() { clicks++; } }
  } }]; };
  assert.equal(await handler.init(), 100);
  assert.equal(clicks, 1);
});

test('metadata, UI and key controls match the new answer source', () => {
  assert(modified.includes('// @connect      *'));
  assert(!/^\/\/ @(updateURL|downloadURL) /m.test(modified));
  assert(!modified.includes('search.tikuhai.com'));
  assert(modified.includes('textContent: scope.row.answer.join()'));
  assert(modified.includes('input(model, "url", "\u6a21\u578b\u63a5\u53e3\u5730\u5740"'));
  assert(modified.includes('models.value, "\u6a21\u578b\u540d"'));
  assert(modified.includes('input(model, "token", "\u6a21\u578b API Key"'));
});

test('native protocols derive answer and model-list endpoints from complete URLs', () => {
  const { api } = createHarness();
  for (const [address, protocol, operation, model, expected] of [
    ['https://model.example/v1/responses', 'responses', 'models', '', 'https://model.example/v1/models'],
    ['https://model.example/v1/messages', 'anthropic', 'answer', '', 'https://model.example/v1/messages'],
    ['https://model.example', 'gemini', 'models', '', 'https://model.example/v1beta/models'],
    ['https://model.example/v1beta/models/gemini-test:generateContent', 'gemini', 'models', '', 'https://model.example/v1beta/models'],
    ['https://model.example/v1beta', 'gemini', 'answer', 'models/gemini-test', 'https://model.example/v1beta/models/gemini-test:generateContent']
  ]) assert.equal(api.getModelEndpoint(address, protocol, operation, model), expected);
});

test('provider authentication never puts keys into URLs or another provider header', () => {
  const { api } = createHarness();
  const anthropic = api.getModelHeaders({ protocol: 'anthropic', token: 'TEST_ANTHROPIC' });
  assert.equal(anthropic['x-api-key'], 'TEST_ANTHROPIC');
  assert.equal(anthropic.Authorization, undefined);
  const gemini = api.getModelHeaders({ protocol: 'gemini', token: 'TEST_GEMINI' });
  assert.equal(gemini['x-goog-api-key'], 'TEST_GEMINI');
  assert.equal(gemini.Authorization, undefined);
});

test('all four protocols construct matching native request and response formats', () => {
  const { api } = createHarness();
  const answer = JSON.stringify({ answerable: true, answers: [2] });
  const responses = {
    responses: { output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] },
    anthropic: { content: [{ type: 'text', text: answer }] },
    gemini: { candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }, { text: answer }] } }] }
  };
  for (const protocol of ['chat', 'responses', 'anthropic', 'gemini']) {
    const request = api.buildModelRequest(question, { protocol, url: 'https://model.example', model: 'model-test', maxTokens: 512, temperatureEnabled: true, temperature: 0.4 });
    const body = JSON.parse(request.data);
    if (protocol === 'responses') { assert.equal(body.max_output_tokens, 512); assert.equal(body.input.length, 2); }
    else if (protocol === 'anthropic') { assert.equal(body.max_tokens, 512); assert(body.system); }
    else if (protocol === 'gemini') { assert.equal(body.generationConfig.maxOutputTokens, 512); assert(body.systemInstruction); }
    else assert.equal(body.max_tokens, 512);
    const result = api.parseModelResponse(responses[protocol] || completion([2]), 200, question, protocol);
    assert.deepEqual(plain(api.getAnswerValues(result, question)), ['B. Beta']);
  }
});

test('generation preferences are optional and cannot remove the answer schema', () => {
  const { api } = createHarness();
  const settings = { url: 'https://model.example', model: 'model-test', prompt: 'Prefer concise answers' };
  const body = JSON.parse(api.buildModelRequest(question, settings).data);
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
  assert(body.messages[0].content.includes('Prefer concise answers'));
  assert(body.messages[0].content.includes('answerable'));
});

test('OpenAI-compatible model list is deduplicated and no model generation is requested', async () => {
  const h = configured();
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] }) });
  const result = await h.api.fetchModelList(h.api.getConfig().queryApis[0]);
  assert.deepEqual(plain(result.models.map((model) => model.id)), ['a-model', 'z-model']);
  assert.equal(h.requests[0].options.method, 'GET');
  assert.equal(h.requests[0].options.url, 'https://model.example/v1/models');
});

test('Gemini model discovery follows pagination and filters non-generative models', async () => {
  const h = configured();
  const settings = { ...h.api.getConfig().queryApis[0], protocol: 'gemini' };
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(options.url.includes('pageToken=') ? { models: [{ name: 'models/gemini-two', supportedGenerationMethods: ['generateContent'] }] } : { models: [{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] }, { name: 'models/gemini-one', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next-token' }) });
  const result = await h.api.fetchModelList(settings);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(plain(result.models.map((model) => model.id)), ['gemini-one', 'gemini-two']);
  assert.equal(h.requests[0].options.headers['x-goog-api-key'], 'TEST_KEY_NOT_A_SECRET');
});

test('Anthropic model discovery follows cursors and preserves authentication', async () => {
  const h = configured();
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(options.url.includes('after_id=') ? { data: [{ id: 'claude-two' }], has_more: false } : { data: [{ id: 'claude-one' }], has_more: true, last_id: 'claude-one' }) });
  const result = await h.api.fetchModelList({ ...h.api.getConfig().queryApis[0], protocol: 'anthropic' });
  assert.equal(result.models.length, 2);
  assert.equal(h.requests[1].options.headers['x-api-key'], 'TEST_KEY_NOT_A_SECRET');
});

test('model discovery reports unsupported lists, authorization errors and cancellation', async () => {
  for (const payload of [{ unsupported: true }, { error: 'invalid' }]) {
    const h = configured();
    h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(payload) });
    assert.equal((await h.api.fetchModelList(h.api.getConfig().queryApis[0])).success, false);
  }
  const h = configured();
  const controller = new AbortController();
  const pending = h.api.fetchModelList(h.api.getConfig().queryApis[0], { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).success, false);
  assert.equal(h.requests[0].aborted, true);
});

test('switching providers restores each profile without sharing credentials', () => {
  const h = configured();
  const config = h.api.getConfig();
  h.api.switchModelProvider(config, 'gemini');
  assert.equal(config.queryApis[0].token, '');
  assert.equal(config.queryApis[0].protocol, 'gemini');
  config.queryApis[0].token = 'TEST_GEMINI';
  config.queryApis[0].model = 'gemini-test';
  h.api.switchModelProvider(config, 'custom');
  assert.equal(config.queryApis[0].token, 'TEST_KEY_NOT_A_SECRET');
  h.api.switchModelProvider(config, 'gemini');
  assert.equal(config.queryApis[0].token, 'TEST_GEMINI');
  assert.equal(config.queryApis[0].model, 'gemini-test');
});

test('search credentials remain in GM storage and survive reloading', () => {
  const h = configured();
  const config = h.api.getConfig();
  config.modelSearch.token = 'TEST_SEARCH_KEY';
  h.api.persistConfig(config);
  for (const text of [h.storage.get('config'), h.storage.get('globalConfig'), h.local.get('config')]) {
    assert(!text.includes('TEST_SEARCH_KEY'));
    assert(!text.includes('TEST_KEY_NOT_A_SECRET'));
  }
  assert.equal(createHarness(Object.fromEntries(h.storage)).api.getConfig().modelSearch.token, 'TEST_SEARCH_KEY');
});

test('Tavily retrieves real response records before generation using a separate key', async () => {
  const h = configured();
  Object.assign(h.api.getConfig().modelSearch, { enabled: true, backend: 'tavily', token: 'TEST_SEARCH_KEY' });
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(options.url.includes('api.tavily.com') ? { results: [{ title: 'Reference', url: 'https://reference.example/page', content: 'Evidence text' }, { url: 'javascript:bad()' }] } : completion([2])) });
  const result = await h.api.getAnswer(question, { skipDelay: true });
  assert.equal(result.success, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer TEST_SEARCH_KEY');
  assert.equal(h.requests[1].options.headers.Authorization, 'Bearer TEST_KEY_NOT_A_SECRET');
  const sent = JSON.parse(JSON.parse(h.requests[1].options.data).messages[1].content);
  assert.equal(sent.webReferences.length, 1);
  assert.equal(sent.webReferences[0].content, 'Evidence text');
  assert.equal(result.meta.search.status, 'searched');
  assert.equal(result.meta.search.sources[0].url, 'https://reference.example/page');
});

test('a failed or empty Tavily search does not silently invoke the model', async () => {
  for (const status of [200, 401]) {
    const h = configured();
    Object.assign(h.api.getConfig().modelSearch, { enabled: true, backend: 'tavily', token: 'TEST_SEARCH_KEY' });
    h.sandbox.autoReply = (options) => options.onload({ status, responseText: JSON.stringify({ results: [] }) });
    assert.equal((await h.api.getAnswer(question, { skipDelay: true })).success, false);
    assert.equal(h.requests.length, 1);
  }
});

test('native search uses protocol-specific tools and rejects unsupported chat services', () => {
  const { api } = createHarness();
  const base = { url: 'https://model.example', model: 'test' };
  const responseBody = JSON.parse(api.buildModelRequest(question, { ...base, protocol: 'responses' }, [], true).data);
  assert.equal(responseBody.tools[0].type, 'web_search');
  assert.equal(responseBody.tool_choice, 'required');
  const anthropic = JSON.parse(api.buildModelRequest(question, { ...base, protocol: 'anthropic' }, [], true).data);
  assert.equal(anthropic.tools[0].name, 'web_search');
  const gemini = JSON.parse(api.buildModelRequest(question, { ...base, protocol: 'gemini' }, [], true).data);
  assert.deepEqual(gemini.tools[0], { google_search: {} });
  const qwen = JSON.parse(api.buildModelRequest(question, { ...base, protocol: 'chat', provider: 'qwen' }, [], true).data);
  assert.equal(qwen.enable_search, true);
  assert.equal(qwen.search_options.forced_search, true);
  assert.throws(() => api.buildModelRequest(question, { ...base, protocol: 'chat' }, [], true));
});

test('native search records only service-returned sources and reports missing search evidence', () => {
  const { api } = createHarness();
  const result = api.getNativeSearchInfo({ output: [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://reference.example/a', title: 'A' }] } }] }, 'responses');
  assert.equal(result.status, 'searched');
  assert.equal(result.sources.length, 1);
  assert.equal(api.getNativeSearchInfo(completion([2]), 'chat').status, 'unconfirmed');
  assert(api.getNativeSearchInfo({ content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error' } }] }, 'anthropic').error);
});

test('personalized timeout and token parameters are included only when configured', async () => {
  const h = configured();
  Object.assign(h.api.getConfig().queryApis[0], { timeout: 45, maxTokens: 768, temperatureEnabled: true, temperature: 0.3 });
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(completion([2])) });
  assert.equal((await h.api.getAnswer(question, { skipDelay: true })).success, true);
  assert.equal(h.requests[0].options.timeout, 45000);
  const body = JSON.parse(h.requests[0].options.data);
  assert.equal(body.max_tokens, 768);
  assert.equal(body.temperature, 0.3);
});

test('malformed successful provider payloads return errors without interrupting the caller', async () => {
  for (const [protocol, payload] of [
    ['responses', { output: {} }], ['responses', { output: [null, { content: {} }] }],
    ['anthropic', { content: {} }], ['anthropic', { content: [null] }],
    ['gemini', { candidates: [{ content: { parts: {} }, groundingMetadata: { groundingChunks: {} } }] }],
    ['chat', { choices: [{ message: { content: [null] } }] }]
  ]) {
    const h = configured();
    h.api.getConfig().queryApis[0].protocol = protocol;
    h.api.getConfig().modelSearch.enabled = protocol !== 'chat';
    h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(payload) });
    assert.equal((await h.api.getAnswer(question, { skipDelay: true })).success, false);
  }
});

test('Anthropic temperature respects the service limit and model identifiers are trimmed', async () => {
  const h = configured();
  const body = JSON.parse(h.api.buildModelRequest(question, { url: 'https://model.example', model: 'test', protocol: 'anthropic', temperatureEnabled: true, temperature: 2 }).data);
  assert.equal(body.temperature, 1);
  h.api.getConfig().queryApis[0].model = '  test-model  ';
  h.sandbox.autoReply = (options) => options.onload({ status: 200, responseText: JSON.stringify(completion([2])) });
  await h.api.getAnswer(question, { skipDelay: true });
  assert.equal(JSON.parse(h.requests[0].options.data).model, 'test-model');
});

test('Gemini preserves service search suggestions along with source links', () => {
  const { api } = createHarness();
  const result = api.getNativeSearchInfo({ candidates: [{ groundingMetadata: { webSearchQueries: ['sample'], searchEntryPoint: { renderedContent: '<div>Search suggestions</div>' }, groundingChunks: [{ web: { uri: 'https://reference.example/a', title: 'Reference' } }] } }] }, 'gemini');
  assert.equal(result.status, 'searched');
  assert.equal(result.suggestions, '<div>Search suggestions</div>');
  assert.equal(result.sources.length, 1);
});
