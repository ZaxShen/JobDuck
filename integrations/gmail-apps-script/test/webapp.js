const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeStore(initial) {
  const data = Object.assign({}, initial);
  return {
    data,
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setProperty: (k, v) => { data[k] = String(v); },
    deleteProperty: (k) => { delete data[k]; },
    getKeys: () => Object.keys(data),
    getProperties: () => Object.assign({}, data),
  };
}

function load(scriptProps, userProps) {
  const logs = [];
  const scriptStore = makeStore(scriptProps);
  const userStore = makeStore(userProps);
  let uuid = 0;
  const sandbox = {
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => scriptStore, getUserProperties: () => userStore },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: (content) => ({
        content,
        mimeType: null,
        setMimeType(m) { this.mimeType = m; return this; },
        getContent() { return this.content; },
      }),
    },
    Utilities: { getUuid: () => '0000000' + (++uuid) + '-aaaa-bbbb-cccc-dddddddddddd' },
    GmailApp: { getUserLabelByName: (name) => (name.startsWith('Job Duck/') ? { name } : null) },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }),
    },
    Session: {},
    Gmail: { Users: { Labels: { list: () => ({ labels: [] }) } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') +
    '\nthis.__api = { doGet, doPost, queueOutcome_, listOutcomes_, ackOutcomes_, generateSyncToken, checkConnection, install, MAX_OUTCOMES };', sandbox);
  return { api: sandbox.__api, logs, scriptStore, userStore };
}

const TOKEN = 'a'.repeat(64);
let failures = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ result: ok ? 'ok' : 'FAIL', test: name });
  if (!ok) { failures++; console.log('FAIL ' + name + (detail !== undefined ? ': ' + JSON.stringify(detail) : '')); }
}

function post(api, body) {
  const out = api.doPost({ postData: { contents: JSON.stringify(body) } });
  return { mime: out.mimeType, json: JSON.parse(out.getContent()) };
}

function outcome(id, receivedAt) {
  return { messageId: id, receivedAt, senderDomain: 'ashbyhq.com', subject: 'Update ' + id, company: 'Acme', title: 'Engineer', jobUrl: null, jobRef: null, applicationId: null, jobId: null };
}

{
  const { api } = load({});
  check('no SYNC_TOKEN property → unauthorized', post(api, { token: TOKEN, action: 'status' }).json.error === 'unauthorized');
}

{
  const { api, scriptStore } = load({ SYNC_TOKEN: TOKEN });
  api.queueOutcome_(outcome('<b@x>', '2026-10-02T00:00:00.000Z'));
  api.queueOutcome_(outcome('<a@x>', '2026-10-01T00:00:00.000Z'));
  api.queueOutcome_(outcome('<c@x>', '2026-10-03T00:00:00.000Z'));
  check('queueOutcome_ is idempotent', api.queueOutcome_(outcome('<a@x>', '2026-10-01T00:00:00.000Z')) === 'exists' &&
    Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:')).length === 3);
  const stored = JSON.parse(scriptStore.data['outcome:<a@x>']);
  check('stored value has the outcome fields and queuedAt, no body', !!stored.queuedAt && stored.senderDomain === 'ashbyhq.com' && !('body' in stored));

  const missing = post(api, { action: 'pending' });
  check('missing token → unauthorized', missing.json.ok === false && missing.json.error === 'unauthorized' && !('outcomes' in missing.json));
  const wrong = post(api, { token: 'b'.repeat(64), action: 'pending' });
  check('wrong token → unauthorized', wrong.json.error === 'unauthorized');
  const prefix = post(api, { token: TOKEN.slice(0, 10), action: 'pending' });
  check('token prefix → unauthorized', prefix.json.error === 'unauthorized');
  const garbage = api.doPost({ postData: { contents: 'not json' } });
  check('unparseable body → unauthorized', JSON.parse(garbage.getContent()).error === 'unauthorized');

  const pending = post(api, { token: TOKEN, action: 'pending' });
  check('pending responds as JSON', pending.mime === 'application/json');
  check('pending returns outcomes sorted by receivedAt', pending.json.ok === true && pending.json.scriptVersion === '5' &&
    pending.json.outcomes.map((o) => o.messageId).join(',') === '<a@x>,<b@x>,<c@x>', pending.json);

  const ack = post(api, { token: TOKEN, action: 'ack', messageIds: ['<a@x>', '<c@x>', '<unknown@x>'] });
  const left = api.listOutcomes_().map((o) => o.messageId);
  check('ack removes exactly the given ids', ack.json.ok === true && ack.json.acked === 2 && left.join(',') === '<b@x>', { ack: ack.json, left });

  const status = post(api, { token: TOKEN, action: 'status' });
  check('status reports mode and pending', status.json.ok === true && status.json.mode === 'serve' && status.json.pending === 1 && status.json.scriptVersion === '5', status.json);

  check('bad action → bad_request', post(api, { token: TOKEN, action: 'delete-all' }).json.error === 'bad_request');
  check('ack without messageIds → bad_request', post(api, { token: TOKEN, action: 'ack' }).json.error === 'bad_request');

  const page = api.doGet({ parameter: { token: TOKEN } }).getContent();
  check('doGet is a one-line page without outcome data or token', page === 'Job Duck Gmail script v5 — POST only' && !page.includes('<b@x>') && !page.includes(TOKEN), page);
}

{
  const { api, logs } = load({ SYNC_TOKEN: TOKEN, JOBDUCK_TOKEN: 'legacy' });
  check('status stays serve mode when JOBDUCK_TOKEN is set', post(api, { token: TOKEN, action: 'status' }).json.mode === 'serve');
  api.checkConnection();
  check('checkConnection notes that JOBDUCK_TOKEN is ignored', logs.some((l) => /Push mode was removed in v5/.test(l)), logs);
}

{
  const { api, userStore } = load({}, { jobduckPendingThreads: '["t1"]', 'jobduckSyncCount_2026-10-01': '3', backfillOffset: '200' });
  api.install();
  check('install clears the v3/v4 push queue and daily counters only', Object.keys(userStore.data).join(',') === 'backfillOffset', userStore.data);
}

{
  const { api, logs, scriptStore } = load({ SYNC_TOKEN: TOKEN });
  for (let i = 0; i < api.MAX_OUTCOMES; i++) api.queueOutcome_(outcome('<m' + i + '@x>', '2026-10-01T00:00:00.000Z'));
  const r = api.queueOutcome_(outcome('<over@x>', '2026-10-02T00:00:00.000Z'));
  const count = Object.keys(scriptStore.data).filter((k) => k.startsWith('outcome:')).length;
  check('1 000-cap stops queueing with a warning', r === 'full' && count === 1000 && logs.some((l) => /Warning: 1000 outcomes are pending/.test(l)), { r, count });
}

{
  const { api, scriptStore } = load({ SYNC_TOKEN: TOKEN });
  const long = outcome('<long@x>', '2026-10-01T00:00:00.000Z');
  long.subject = 'S'.repeat(5000);
  long.title = 'T'.repeat(5000);
  api.queueOutcome_(long);
  const raw = scriptStore.data['outcome:<long@x>'];
  const v = JSON.parse(raw);
  check('subject/title truncated to 200 and value under 8 KB', v.subject.length === 200 && v.title.length === 200 && raw.length < 8192);
}

{
  const { api, logs, scriptStore } = load({});
  api.generateSyncToken();
  const t = scriptStore.data.SYNC_TOKEN;
  check('generateSyncToken stores a 64-hex-char token and logs it once', /^[0-9a-f]{64}$/.test(t) && logs.filter((l) => l.includes(t)).length === 1, t);
}

console.table(results);
console.log(failures ? failures + ' failure(s)' : 'all ' + results.length + ' web-app tests pass');
process.exit(failures ? 1 : 0);
