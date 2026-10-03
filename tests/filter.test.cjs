const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync('Code.gs', 'utf8');

function setup() {
  const values = {};
  const properties = {
    getProperty: key => values[key] ?? null,
    setProperty: (key, value) => { assert.ok(Buffer.byteLength(value) < 9000); values[key] = value; },
    deleteProperty: key => { delete values[key]; },
  };
  const actions = [], labels = {}, searches = [];
  let threads = [], triggers = [], lockAvailable = true, released = false;
  const c = vm.createContext({
    PropertiesService: { getUserProperties: () => properties },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()] },
    LockService: { getScriptLock: () => ({ tryLock: () => lockAvailable, releaseLock: () => { released = true; } }) },
    Gmail: { Users: { Messages: { get: (_, id) => ({ labelIds: labels[id] || [] }) } } },
    GmailApp: { search: (query, offset, limit) => { searches.push({ query, offset, limit }); return threads.slice(offset, offset + limit); } },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: t => { triggers = triggers.filter(x => x !== t); },
      newTrigger: () => ({ timeBased() { return this; }, everyMinutes(n) { this.minutes = n; return this; }, create() { triggers.push({ getHandlerFunction: () => 'runFilters', minutes: this.minutes }); } }),
    },
  });
  vm.runInContext(source, c);
  c.applyAction = (msg, rule) => actions.push([msg.getId(), rule.id]);
  const message = (id, scope = ['INBOX'], subject = 'promo') => {
    labels[id] = scope;
    return { getId: () => id, getDate: () => new Date(), getFrom: () => 'sender@example.com', getTo: () => 'me@example.com', getSubject: () => subject, getPlainBody: () => subject, getBody: () => subject };
  };
  return { c, values, actions, searches, message,
    setThreads: groups => { threads = groups.map((messages, i) => ({ getId: () => 't' + i, getMessages: () => messages })); },
    triggers: () => triggers,
    setLock: value => { lockAvailable = value; },
    released: () => released,
  };
}
function rule(c, id, scope = ['inbox'], pattern = 'promo') {
  return c.normalizeRule({ id, name: id, scope, action: 'star', conditions: [{ field: 'subject', pattern }] });
}

test('case sensitivity works for all matching modes and diagnostic flags', () => {
  const { c, message } = setup();
  for (const mode of ['contains', 'equals', 'regex']) {
    assert.equal(c.matchCondition('promo', { mode, pattern: 'PROMO', flags: '' }), false);
    assert.equal(c.matchCondition('promo', { mode, pattern: 'PROMO', flags: 'i' }), true);
    assert.equal(c.matchCondition('promo', { mode, pattern: 'PROMO' }), true);
  }
  const r = rule(c, 'r'); r.conditions[0].flags = '';
  assert.equal(c.evaluateConditions(message('m'), r).condResults[0].flags, '');
});

test('pattern run, test, and debug exclude other messages in a mixed conversation', () => {
  const h = setup(), { c } = h;
  h.setThreads([[h.message('inbox'), h.message('archived', []), h.message('sent', ['SENT']), h.message('spam', ['SPAM'])]]);
  c.saveRules([rule(c, 'r')]);
  assert.equal(c.testRule(c.getRules()[0].conditions, 'AND', ['inbox']).matches.length, 1);
  assert.equal(c.debugRule('r').results.length, 1);
  const report = c.runFilters();
  assert.deepEqual(h.actions, [['inbox', 'r']]);
  assert.equal(report.scanned, 1);
  assert.equal(report.actions, 1);
  assert.equal(report.status, 'completed');
  assert.ok(c.getStats().lastRun.lastSuccessfulRunAt);
});

test('all scopes check message labels with union and Everywhere behavior', () => {
  const { c, message } = setup();
  for (const scope of ['inbox', 'spam', 'trash', 'sent']) {
    assert.equal(c.messageMatchesScope_(message(scope, [scope.toUpperCase()]), [scope], {}), true);
    assert.equal(c.messageMatchesScope_(message('archived', []), [scope], {}), false);
  }
  assert.equal(c.messageMatchesScope_(message('sent', ['SENT']), ['inbox', 'sent'], {}), true);
  assert.equal(c.messageMatchesScope_(message('archived', []), ['anywhere'], {}), true);
});

test('rules retain displayed order across scopes and act once per message', () => {
  const h = setup(), { c } = h;
  h.setThreads([[h.message('m')]]);
  c.saveRules([rule(c, 'A', ['inbox'], 'no match'), rule(c, 'B', ['anywhere']), rule(c, 'C')]);
  c.runFilters();
  assert.deepEqual(h.actions, [['m', 'B']]);
  c.runFilters();
  assert.deepEqual(h.actions, [['m', 'B']]);
  assert.equal(c.getRules().find(r => r.id === 'B').hits, 1);
});

test('timer changes preserve stopped state and update an active trigger', () => {
  const h = setup(), { c } = h;
  c.updateInterval(10);
  assert.equal(h.triggers().length, 0);
  c.activateTrigger();
  c.updateInterval(15);
  assert.equal(h.triggers().length, 1);
  assert.equal(h.triggers()[0].minutes, 15);
  assert.throws(() => c.updateInterval(7), /Invalid interval/);
});

test('AI candidates page past cached threads and enforce message scope', () => {
  const h = setup(), { c } = h;
  const cache = {};
  h.setThreads(Array.from({ length: 121 }, (_, i) => [h.message('m' + i, i === 120 ? [] : ['INBOX'])]));
  for (let i = 0; i < 120; i++) cache[c.shortHash('v|m' + i)] = 'cached';
  delete cache[c.shortHash('v|m110')];
  const candidates = c.getAiRuleCandidates_(rule(c, 'r'), { maxBodyChars: 6000 }, new Date(Date.now() - 86400000), {}, cache, 'v', 20);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'm110');
  assert.deepEqual(h.searches.map(s => s.offset), [0, 100]);
});

test('AI pagination stops when evaluation budget is filled', () => {
  const h = setup(), { c } = h;
  h.setThreads(Array.from({ length: 250 }, (_, i) => [h.message('m' + i)]));
  assert.equal(c.getAiRuleCandidates_(rule(c, 'r'), { maxBodyChars: 6000 }, new Date(0), {}, {}, 'v', 5).length, 5);
  assert.equal(h.searches.length, 1);
});

test('AI cache retains a full scan, migrates legacy cache, and clears all chunks', () => {
  const { c, values } = setup();
  values[c.AI_CACHE_KEY] = JSON.stringify({ legacy: '2026-10-04' });
  const cache = c.getAiCache_();
  for (let i = 0; i < 1500; i++) cache[c.shortHash('message' + i)] = new Date().toISOString();
  c.saveAiCache_(cache);
  assert.equal(Object.keys(c.getAiCache_()).length, 1501);
  assert.equal(values[c.AI_CACHE_KEY], undefined);
  c.saveAiCache_({ small: 'now' });
  assert.equal(Object.keys(c.getAiCache_()).length, 1);
  c.clearAiCache();
  assert.equal(Object.keys(values).filter(key => key.startsWith(c.AI_CACHE_KEY)).length, 0);
});

test('skipped runs report skipped and do not overwrite the previous run', () => {
  const h = setup(), { c } = h;
  c.runFilters();
  const previous = h.values[c.RUN_STATUS_KEY];
  h.setLock(false);
  assert.equal(c.runFiltersNow().status, 'skipped');
  assert.equal(h.values[c.RUN_STATUS_KEY], previous);
});

test('fatal failures preserve last success, record error, and release lock', () => {
  const h = setup(), { c } = h;
  c.runFilters();
  const success = c.getStats().lastRun.lastSuccessfulRunAt;
  c.runFiltersLocked_ = () => { throw new Error('Gmail unavailable'); };
  assert.throws(() => c.runFilters(), /Gmail unavailable/);
  const report = c.getStats().lastRun;
  assert.equal(report.status, 'failed');
  assert.equal(report.errors, 1);
  assert.equal(report.lastSuccessfulRunAt, success);
  assert.equal(h.released(), true);
});

test('action failures are visible in completed run summary', () => {
  const h = setup(), { c } = h;
  h.setThreads([[h.message('m')]]);
  c.saveRules([rule(c, 'r')]);
  c.applyAction = () => { throw new Error('Permission denied'); };
  const report = c.runFilters();
  assert.equal(report.status, 'completed_with_errors');
  assert.equal(report.actions, 0);
  assert.equal(report.errors, 1);
  assert.match(c.getLogs()[0].subject, /Permission denied/);
});

test('scope lookup failures fail closed instead of acting on the conversation', () => {
  const h = setup(), { c } = h;
  h.setThreads([[h.message('m')]]);
  c.saveRules([rule(c, 'r')]);
  c.Gmail.Users.Messages.get = () => { throw new Error('Metadata unavailable'); };
  assert.equal(c.runFilters().status, 'completed_with_errors');
  assert.deepEqual(h.actions, []);
});

test('AI live and dry runs preserve scope checks and report actual action counts', () => {
  for (const dryRun of [true, false]) {
    const h = setup(), { c } = h;
    h.setThreads([[h.message('inbox'), h.message('archived', [])]]);
    h.values[c.AI_API_KEY_KEY] = 'mock-key';
    c.saveSettings({ ai: { dryRun } });
    c.saveRules([c.normalizeRule({ id: 'ai', type: 'ai', aiPrompt: 'Promotions', action: 'star', scope: ['inbox'] })]);
    const classified = [];
    c.classifyAiRuleBatch_ = batch => batch.map(candidate => {
      classified.push(candidate.id);
      return { id: candidate.id, matchScore: 100, confidence: 100, reason: 'Mock match' };
    });
    const report = c.runFilters();
    assert.deepEqual(classified, ['inbox']);
    assert.equal(report.actions, dryRun ? 0 : 1);
    assert.equal(report.scanned, 1);
    assert.equal(report.status, 'completed');
    c.runFilters();
    assert.equal(classified.length, 1, 'cached mail should not be classified again');
  }
});

test('cached pattern messages are not reread after a destructive action', () => {
  const h = setup(), { c } = h;
  const msg = h.message('m');
  let removed = false;
  c.GmailApp.search = () => [{ getId: () => 't', getMessages: () => {
    if (removed) throw new Error('Thread no longer exists');
    return [msg];
  } }];
  c.saveRules([rule(c, 'first'), rule(c, 'second')]);
  c.applyAction = () => { removed = true; msg.getDate = () => { throw new Error('Message no longer exists'); }; };
  assert.equal(c.runFilters().status, 'completed');
});
