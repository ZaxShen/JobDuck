const fs = require('fs');
const path = require('path');
const vm = require('vm');

const noop = () => {};
const sandbox = {
  Logger: { log: noop },
  PropertiesService: { getUserProperties: () => ({ getProperty: noop, getKeys: () => [] }), getScriptProperties: () => ({ getProperty: noop }) },
  GmailApp: {},
  ScriptApp: {},
  Session: {},
  Gmail: {},
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8') + '\nthis.__api = { jobScore, denyScore, isRejection, JOB_THRESHOLD };', sandbox);
const api = sandbox.__api;

function classify(f) {
  if (api.jobScore(f.from, f.subject, f.body).score < api.JOB_THRESHOLD) return 'skip';
  return api.isRejection(f.subject, f.body) ? 'rejection' : 'job';
}

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
let failures = 0;
const rows = fixtures.map((f) => {
  const actual = classify(f);
  const ok = actual === f.expect;
  if (!ok) failures++;
  const d = api.denyScore(f.subject, f.body);
  return { result: ok ? 'ok' : 'FAIL', name: f.name, expect: f.expect, actual, deny: d.score, strong: d.strong };
});
console.table(rows);

const commure = fixtures.find((f) => f.name.startsWith('Commure'));
const c = api.denyScore(commure.subject, commure.body);
if (!(c.score >= 3 && c.strong)) { failures++; console.log('Commure denyScore expected score >= 3 and strong, got', c); }
['Cisco', 'Green Dot'].forEach((prefix) => {
  const f = fixtures.find((x) => x.name.startsWith(prefix));
  if (api.denyScore(f.subject, f.body).strong) { failures++; console.log(prefix + ' expected strong = false'); }
});
fixtures.filter((f) => f.negative).forEach((f) => {
  const reasons = api.jobScore(f.from, f.subject, f.body).reasons;
  if (!reasons.includes('not application mail: ' + f.negative)) { failures++; console.log(f.name + ' expected reason "not application mail: ' + f.negative + '", got', reasons); }
});
if (!/SCRIPT_VERSION = '5'/.test(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'))) { failures++; console.log('SCRIPT_VERSION is not 5'); }

console.log(failures ? failures + ' failure(s)' : 'all ' + rows.length + ' fixtures pass');
process.exit(failures ? 1 : 0);
