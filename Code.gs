// ============================================================
//  Gmail Filter App — Code.gs  (v5)
//  Critical fixes:
//   - Added debugRule() to diagnose exactly why emails match
//   - Log entries slimmed down to stay under 9KB PropertiesService limit
//   - Body snippet reduced to 150 chars
//   - Thread-level deduplication: once a thread is actioned by a rule, skip it
//   - condResults stored only for matched conditions to save space
//   - Clearer error messages
// ============================================================

var RULES_KEY = "gmail_filter_rules";
var LOG_KEY = "gmail_filter_log";
var SETTINGS_KEY = "gmail_filter_settings";
var PROCESSED_KEY = "gmail_filter_processed";
var MAX_SCAN_LOOKBACK_DAYS = 7;
var MAX_SCAN_THREADS = 1500;
var SEARCH_PAGE_SIZE = 100;
var MAX_PROCESSED = 2000;
var MAX_LOG = 25; // prefer fewer, richer entries so rule/body details survive

// ------------------------------------------------------------
//  Web App entry point
// ------------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile("Ui")
    .addMetaTag(
      "viewport",
      "width=device-width, initial-scale=1, viewport-fit=cover",
    )
    .setTitle("Gmail Filter Rules")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ------------------------------------------------------------
//  Settings
// ------------------------------------------------------------
function getSettings() {
  var raw = PropertiesService.getUserProperties().getProperty(SETTINGS_KEY);
  var settings = raw ? JSON.parse(raw) : {};
  if (!settings.intervalMinutes) settings.intervalMinutes = 1;
  return settings;
}

function saveSettings(s) {
  PropertiesService.getUserProperties().setProperty(
    SETTINGS_KEY,
    JSON.stringify(s),
  );
  return true;
}

function updateInterval(minutes) {
  minutes = parseInt(minutes, 10);
  if ([1, 5, 10, 15, 30].indexOf(minutes) === -1)
    throw new Error("Invalid interval");
  var s = getSettings();
  s.intervalMinutes = minutes;
  saveSettings(s);
  createTrigger(minutes);
  return "Timer updated to every " + minutes + " minute(s).";
}

// ------------------------------------------------------------
//  Rule storage
// ------------------------------------------------------------
function getRules() {
  var raw = PropertiesService.getUserProperties().getProperty(RULES_KEY);
  return (raw ? JSON.parse(raw) : []).map(normalizeRule);
}

function saveRules(rules) {
  PropertiesService.getUserProperties().setProperty(
    RULES_KEY,
    JSON.stringify(rules),
  );
  return true;
}

function addRule(rule) {
  var rules = getRules();
  rule = normalizeRule(rule);
  rule.id = Utilities.getUuid();
  rule.createdAt = new Date().toISOString();
  rule.hits = 0;
  rule.enabled = true;
  if (!rule.scope || !rule.scope.length) rule.scope = ["inbox"];
  if (!rule.logic) rule.logic = "AND";
  if (!rule.conditions || !rule.conditions.length)
    throw new Error("Rule must have at least one condition");
  validateRule(rule);
  rules.push(rule);
  saveRules(rules);
  return rule;
}

function updateRule(updated) {
  var rules = getRules();
  updated = normalizeRule(updated);
  var found = false;
  rules = rules.map(function (r) {
    if (r.id !== updated.id) return r;
    found = true;
    return {
      id: r.id,
      createdAt: r.createdAt,
      hits: r.hits || 0,
      enabled: r.enabled !== false,
      name: updated.name,
      conditions: updated.conditions,
      logic: updated.logic || "AND",
      action: updated.action,
      label: updated.label || "",
      scope: updated.scope || ["inbox"],
    };
  });
  if (!found) throw new Error("Rule not found");
  validateRule(updated);
  saveRules(rules);
  return updated;
}

function deleteRule(id) {
  saveRules(
    getRules().filter(function (r) {
      return r.id !== id;
    }),
  );
  return true;
}

function toggleRule(id) {
  saveRules(
    getRules().map(function (r) {
      if (r.id === id) r.enabled = !r.enabled;
      return r;
    }),
  );
  return true;
}

function moveRule(id, direction) {
  var rules = getRules();
  var idx = -1;
  rules.forEach(function (r, i) {
    if (r.id === id) idx = i;
  });
  if (idx === -1) return false;
  var newIdx = direction === "up" ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= rules.length) return false;
  var tmp = rules[idx];
  rules[idx] = rules[newIdx];
  rules[newIdx] = tmp;
  saveRules(rules);
  return true;
}

function moveRuleToIndex(id, newIndex) {
  var rules = getRules();
  var idx = -1;
  rules.forEach(function (r, i) {
    if (r.id === id) idx = i;
  });
  if (idx === -1) return false;
  newIndex = Math.max(0, Math.min(parseInt(newIndex, 10), rules.length - 1));
  if (idx === newIndex) return false;

  var moved = rules.splice(idx, 1)[0];
  rules.splice(newIndex, 0, moved);
  saveRules(rules);
  return true;
}

// ------------------------------------------------------------
//  Log storage
// ------------------------------------------------------------
function getLogs() {
  var raw = PropertiesService.getUserProperties().getProperty(LOG_KEY);
  var logs = raw ? JSON.parse(raw) : [];
  var ruleMap = {};
  getRules().forEach(function (rule) {
    ruleMap[rule.id] = rule.name || "Unnamed rule";
  });
  return logs.map(function (entry) {
    return normalizeLogEntry(entry, ruleMap);
  });
}

function _flushLogs(newEntries) {
  if (!newEntries.length) return;
  var existing = getLogs();
  var combined = newEntries.concat(existing);
  if (combined.length > MAX_LOG) combined = combined.slice(0, MAX_LOG);
  var json = JSON.stringify(combined);
  // safety: trim condition previews before dropping body/rule context
  if (json.length > 8000) {
    combined = combined.map(function (e) {
      return Object.assign({}, e, {
        conditions: (e.conditions || []).map(function (c) {
          return Object.assign({}, c, { actualValue: "" });
        }),
      });
    });
    json = JSON.stringify(combined);
  }
  // next fallback: drop body snippets
  if (json.length > 8000) {
    combined = combined.map(function (e) {
      return Object.assign({}, e, { body: "" });
    });
    json = JSON.stringify(combined);
  }
  // last resort: keep only 10 entries
  if (json.length > 8000) {
    combined = combined.slice(0, 10);
    json = JSON.stringify(combined);
  }
  PropertiesService.getUserProperties().setProperty(LOG_KEY, json);
}

function clearLogs() {
  PropertiesService.getUserProperties().deleteProperty(LOG_KEY);
  return true;
}

// ------------------------------------------------------------
//  Build Gmail search query from scope array
// ------------------------------------------------------------
function buildScopeQuery(scope) {
  if (!scope || !scope.length) return "in:inbox";
  if (scope.indexOf("anywhere") !== -1) return "in:anywhere";
  var parts = scope.map(function (s) {
    switch (s) {
      case "inbox":
        return "in:inbox";
      case "spam":
        return "in:spam";
      case "trash":
        return "in:trash";
      case "sent":
        return "in:sent";
      default:
        return "in:inbox";
    }
  });
  return parts.length === 1 ? parts[0] : "(" + parts.join(" OR ") + ")";
}

// ------------------------------------------------------------
//  Evaluate conditions for a single message
//  Returns { passed: bool, condResults: [{field, pattern, matched, actualValue}] }
// ------------------------------------------------------------
function evaluateConditions(msg, rule) {
  var condResults = (rule.conditions || []).map(function (cond) {
    var actualValue = getFieldValue(msg, cond.field);
    var matched = matchCondition(actualValue, cond);
    return {
      field: cond.field,
      pattern: cond.pattern,
      flags: cond.flags || "i",
      mode: cond.mode || "contains",
      matched: matched,
      actualValue: makeSnippet(actualValue, 120),
    };
  });

  var passed =
    rule.logic === "OR"
      ? condResults.some(function (r) {
          return r.matched;
        })
      : condResults.every(function (r) {
          return r.matched;
        });

  return { passed: passed, condResults: condResults };
}

// ------------------------------------------------------------
//  DEBUG: explain exactly why a rule matches/doesn't for recent emails
// ------------------------------------------------------------
function debugRule(ruleId) {
  var rules = getRules();
  var rule = null;
  rules.forEach(function (r) {
    if (r.id === ruleId) rule = r;
  });
  if (!rule) return { ok: false, error: "Rule not found" };

  try {
    var scopeQuery = buildScopeQuery(rule.scope);
    var threads = GmailApp.search(scopeQuery, 0, 20);
    var results = [];

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        if (results.length >= 20) return;
        var eval_ = evaluateConditions(msg, rule);
        results.push({
          from: msg.getFrom(),
          subject: msg.getSubject(),
          date: msg.getDate().toISOString(),
          passed: eval_.passed,
          conditions: eval_.condResults,
        });
      });
    });

    return { ok: true, rule: rule, results: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ------------------------------------------------------------
//  Test rule (for UI test button)
// ------------------------------------------------------------
function testRule(conditions, logic, scope) {
  try {
    var rule = { conditions: conditions, logic: logic };
    var scopeQuery = buildScopeQuery(scope && scope.length ? scope : ["inbox"]);
    var threads = GmailApp.search(scopeQuery, 0, 30);
    var matches = [];

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        if (matches.length >= 30) return;
        var eval_ = evaluateConditions(msg, rule);
        if (eval_.passed) {
          matches.push({
            from: msg.getFrom(),
            subject: msg.getSubject(),
            date: msg.getDate().toISOString(),
            conditions: eval_.condResults,
          });
        }
      });
    });

    return { ok: true, matches: matches };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ------------------------------------------------------------
//  Core filter runner
// ------------------------------------------------------------
function runFilters() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    _flushLogs([
      {
        ts: new Date().toISOString(),
        action: "WARN",
        subject: "Skipped run because another filter run is still active.",
        conditions: [],
      },
    ]);
    return;
  }

  try {
    runFiltersLocked_();
  } finally {
    lock.releaseLock();
  }
}

function runFiltersLocked_() {
  var logsToWrite = [];
  var rules = getRules()
    .filter(function (r) {
      return r.enabled !== false;
    })
    .filter(function (r) {
      try {
        validateRule(r);
        return true;
      } catch (e) {
        logsToWrite.push({
          ts: new Date().toISOString(),
          ruleId: r.id || "",
          ruleName: r.name || "Unnamed rule",
          action: "ERROR",
          subject: "Skipped invalid rule: " + e.message,
          conditions: [],
        });
        return false;
      }
    });
  if (!rules.length) {
    _flushLogs(logsToWrite);
    return;
  }

  var settings = getSettings();
  var intervalMinutes = settings.intervalMinutes || 1;
  var now = new Date();
  var bufferMinutes = Math.max(5, intervalMinutes * 2);
  var fallbackSince = new Date(
    now.getTime() - (intervalMinutes + bufferMinutes) * 60 * 1000,
  );
  var lastRunAt = settings.lastRunAt ? new Date(settings.lastRunAt) : null;
  var oldestAllowed = new Date(
    now.getTime() - MAX_SCAN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  var since =
    lastRunAt && !isNaN(lastRunAt.getTime()) ? lastRunAt : fallbackSince;
  since = new Date(since.getTime() - bufferMinutes * 60 * 1000);
  if (since < oldestAllowed) since = oldestAllowed;
  var searchAfter = new Date(since.getTime() - 24 * 60 * 60 * 1000);
  var dateQuery = formatGmailSearchDate(searchAfter);

  // group rules by scope query
  var queryMap = {};
  rules.forEach(function (rule) {
    var q = buildScopeQuery(rule.scope);
    if (!queryMap[q]) queryMap[q] = [];
    queryMap[q].push(rule);
  });

  var hitMap = {};
  var processed = getProcessedMap();
  var processedChanged = false;
  Object.keys(queryMap).forEach(function (scopeQuery) {
    var scopeRules = queryMap[scopeQuery];
    var threads = searchThreads(scopeQuery + " after:" + dateQuery);

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        if (msg.getDate() < since) return;
        var actionTaken = false;

        scopeRules.forEach(function (rule) {
          if (actionTaken) return;

          try {
            var processedKey = makeProcessedKey(rule, msg.getId());
            if (processed[processedKey]) return;

            var eval_ = evaluateConditions(msg, rule);
            if (!eval_.passed) return;

            var fromValue = msg.getFrom();
            var subjectValue = msg.getSubject();
            var bodySnippet = "";
            try {
              bodySnippet = makeSnippet(getMessageBodyForMatching(msg), 200);
            } catch (e) {}

            applyAction(msg, rule);
            actionTaken = true;
            processed[processedKey] = new Date().toISOString();
            processedChanged = true;

            hitMap[rule.id] = (hitMap[rule.id] || 0) + 1;

            logsToWrite.push({
              ts: new Date().toISOString(),
              ruleId: rule.id,
              ruleName: rule.name || "Unnamed rule",
              action: rule.action,
              logic: rule.logic,
              messageId: msg.getId(),
              threadId: thread.getId(),
              from: fromValue,
              subject: subjectValue,
              body: bodySnippet,
              conditions: eval_.condResults.map(function (c) {
                return {
                  field: c.field,
                  pattern: c.pattern,
                  flags: c.flags,
                  mode: c.mode,
                  matched: c.matched,
                  actualValue: c.actualValue,
                };
              }),
            });
          } catch (e) {
            logsToWrite.push({
              ts: new Date().toISOString(),
              ruleId: rule.id,
              ruleName: rule.name || "Unnamed rule",
              action: "ERROR",
              logic: rule.logic,
              messageId: msg.getId(),
              threadId: thread.getId(),
              from: msg.getFrom(),
              subject: e.message,
              body: "",
              conditions: [],
            });
          }
        });
      });
    });
  });

  // single write at end
  if (Object.keys(hitMap).length) {
    var allRules = getRules();
    saveRules(
      allRules.map(function (r) {
        if (hitMap[r.id]) r.hits = (r.hits || 0) + hitMap[r.id];
        return r;
      }),
    );
  }
  if (processedChanged) saveProcessedMap(processed);
  _flushLogs(logsToWrite);
  settings.lastRunAt = now.toISOString();
  saveSettings(settings);
}

function searchThreads(query) {
  var allThreads = [];
  for (
    var start = 0;
    start < MAX_SCAN_THREADS;
    start += SEARCH_PAGE_SIZE
  ) {
    var pageSize = Math.min(SEARCH_PAGE_SIZE, MAX_SCAN_THREADS - start);
    var page = GmailApp.search(query, start, pageSize);
    if (!page.length) break;
    allThreads = allThreads.concat(page);
    if (page.length < pageSize) break;
  }
  return allThreads;
}

function getProcessedMap() {
  var raw = PropertiesService.getUserProperties().getProperty(PROCESSED_KEY);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveProcessedMap(processed) {
  var entries = Object.keys(processed).map(function (key) {
    return { key: key, ts: processed[key] };
  });
  entries.sort(function (a, b) {
    return String(b.ts).localeCompare(String(a.ts));
  });
  entries = entries.slice(0, MAX_PROCESSED);

  var trimmed = {};
  entries.forEach(function (entry) {
    trimmed[entry.key] = entry.ts;
  });

  var json = JSON.stringify(trimmed);
  while (json.length > 8000 && entries.length > 100) {
    entries = entries.slice(0, Math.floor(entries.length * 0.8));
    trimmed = {};
    entries.forEach(function (entry) {
      trimmed[entry.key] = entry.ts;
    });
    json = JSON.stringify(trimmed);
  }

  PropertiesService.getUserProperties().setProperty(PROCESSED_KEY, json);
}

function makeProcessedKey(rule, messageId) {
  var ruleSignature = JSON.stringify({
    id: rule.id || "",
    action: rule.action || "",
    label: rule.label || "",
    logic: rule.logic || "AND",
    conditions: rule.conditions || [],
  });
  return shortHash(ruleSignature + "|" + String(messageId || ""));
}

function shortHash(value) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
  );
  return digest
    .slice(0, 12)
    .map(function (byte) {
      var unsigned = byte < 0 ? byte + 256 : byte;
      return (unsigned + 256).toString(16).slice(-2);
    })
    .join("");
}

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------
function getFieldValue(msg, field) {
  switch (field) {
    case "from":
      return msg.getFrom();
    case "to":
      return msg.getTo();
    case "subject":
      return msg.getSubject();
    case "body":
      return getMessageBodyForMatching(msg);
    default:
      return "";
  }
}

function formatGmailSearchDate(date) {
  return (
    date.getFullYear() +
    "/" +
    pad2(date.getMonth() + 1) +
    "/" +
    pad2(date.getDate())
  );
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}

function getMessageBodyForMatching(msg) {
  var plain = "";
  var htmlText = "";

  try {
    plain = msg.getPlainBody() || "";
  } catch (e) {}

  try {
    htmlText = htmlToText(msg.getBody() || "");
  } catch (e) {}

  if (!htmlText) return plain;
  if (!plain) return htmlText;
  if (plain.indexOf(htmlText) !== -1 || htmlText.indexOf(plain) !== -1) {
    return plain.length >= htmlText.length ? plain : htmlText;
  }
  return plain + "\n" + htmlText;
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, function (_, code) {
      return String.fromCharCode(parseInt(code, 10));
    })
    .replace(/&#x([0-9a-f]+);/gi, function (_, code) {
      return String.fromCharCode(parseInt(code, 16));
    });
}

function normalizeCondition(cond) {
  cond = cond || {};
  var field = cond.field || "subject";
  if (["from", "to", "subject", "body"].indexOf(field) === -1) {
    field = "subject";
  }
  var mode = cond.mode || "contains";
  if (mode === "exact") mode = "contains";
  return {
    field: field,
    pattern: String(cond.pattern || ""),
    flags: typeof cond.flags === "string" ? cond.flags : "i",
    mode:
      mode === "regex" || mode === "equals" || mode === "contains"
        ? mode
        : "contains",
  };
}

function normalizeRule(rule) {
  rule = rule || {};
  return Object.assign({}, rule, {
    logic: rule.logic === "OR" ? "OR" : "AND",
    action: String(rule.action || "trash"),
    label: String(rule.label || ""),
    scope: normalizeScope(rule.scope),
    conditions: (rule.conditions || []).map(normalizeCondition),
  });
}

function normalizeScope(scope) {
  var valid = ["inbox", "spam", "trash", "sent"];
  if (!scope || !scope.length) return ["inbox"];
  if (scope.indexOf("anywhere") !== -1) return ["anywhere"];
  var normalized = [];
  scope.forEach(function (item) {
    if (valid.indexOf(item) !== -1 && normalized.indexOf(item) === -1) {
      normalized.push(item);
    }
  });
  return normalized.length ? normalized : ["inbox"];
}

function validateRule(rule) {
  var validActions = [
    "trash",
    "delete",
    "archive",
    "label",
    "label+archive",
    "trash+label",
    "star",
    "markread",
  ];
  var validFields = ["from", "to", "subject", "body"];
  var validModes = ["contains", "equals", "regex"];

  if (validActions.indexOf(rule.action) === -1) {
    throw new Error("Invalid rule action");
  }
  if (
    (rule.action === "label" ||
      rule.action === "label+archive" ||
      rule.action === "trash+label") &&
    !String(rule.label || "").trim()
  ) {
    throw new Error("Label action requires a label name");
  }
  if (!rule.conditions || !rule.conditions.length) {
    throw new Error("Rule must have at least one condition");
  }

  rule.conditions.forEach(function (cond, index) {
    var label = "Condition " + (index + 1);
    if (validFields.indexOf(cond.field) === -1) {
      throw new Error(label + " has an invalid field");
    }
    if (validModes.indexOf(cond.mode) === -1) {
      throw new Error(label + " has an invalid match mode");
    }
    if (!String(cond.pattern || "").trim()) {
      throw new Error(label + " has an empty pattern");
    }
    if (cond.mode === "regex") {
      try {
        new RegExp(cond.pattern, cond.flags || "i");
      } catch (e) {
        throw new Error(label + ": invalid regex - " + e.message);
      }
    }
  });
}

function makeSnippet(value, limit) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, limit || 120);
}

function escapeRegexLiteral(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchCondition(actualValue, cond) {
  var pattern = String(cond.pattern || "");
  var flags = cond.flags || "i";
  var mode = cond.mode || "contains";
  var actual = String(actualValue || "");

  if (mode === "regex") {
    return new RegExp(pattern, flags).test(actual);
  }

  if (flags.indexOf("i") !== -1) {
    actual = actual.toLowerCase();
    pattern = pattern.toLowerCase();
  }

  if (mode === "equals") {
    return actual === pattern;
  }

  return actual.indexOf(pattern) !== -1;
}

function normalizeLogEntry(entry, ruleMap) {
  entry = entry || {};
  return {
    ts: entry.ts || "",
    ruleId: entry.ruleId || "",
    ruleName:
      entry.ruleName || entry.rule || ruleMap[entry.ruleId] || "Unknown",
    action: entry.action || "UNKNOWN",
    logic: entry.logic || "AND",
    messageId: entry.messageId || "",
    threadId: entry.threadId || "",
    from: entry.from || "",
    subject: entry.subject || "",
    body: entry.body || entry.bodySnippet || "",
    conditions: (entry.conditions || []).map(function (cond) {
      return {
        field: cond.field || "",
        pattern: cond.pattern || "",
        flags: cond.flags || "i",
        mode: cond.mode || "contains",
        matched: cond.matched === true,
        actualValue: cond.actualValue || "",
      };
    }),
  };
}

function _getLabelId(name) {
  _getOrCreateLabel(name);
  var response = Gmail.Users.Labels.list("me");
  var labels = (response && response.labels) || [];
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].name.toLowerCase() === String(name).toLowerCase()) {
      return labels[i].id;
    }
  }
  throw new Error('Could not resolve label "' + name + '"');
}

function _modifyMessageLabels(messageId, addLabelIds, removeLabelIds) {
  var resource = {};
  if (addLabelIds && addLabelIds.length) resource.addLabelIds = addLabelIds;
  if (removeLabelIds && removeLabelIds.length)
    resource.removeLabelIds = removeLabelIds;
  Gmail.Users.Messages.modify(resource, "me", messageId);
}

function applyAction(msg, rule) {
  var messageId = msg.getId();
  switch (rule.action) {
    case "trash":
      Gmail.Users.Messages.trash("me", messageId);
      break;
    case "delete":
      try {
        Gmail.Users.Messages.remove("me", messageId);
      } catch (e) {
        throw new Error("Permanent delete failed: " + e.message);
      }
      break;
    case "archive":
      _modifyMessageLabels(messageId, [], ["INBOX"]);
      break;
    case "label":
      _modifyMessageLabels(messageId, [_getLabelId(rule.label)], []);
      break;
    case "label+archive":
      _modifyMessageLabels(messageId, [_getLabelId(rule.label)], ["INBOX"]);
      break;
    case "trash+label":
      _modifyMessageLabels(messageId, [_getLabelId(rule.label)], []);
      Gmail.Users.Messages.trash("me", messageId);
      break;
    case "star":
      msg.star();
      break;
    case "markread":
      msg.markRead();
      break;
  }
}

function _getOrCreateLabel(name) {
  try {
    return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  } catch (e) {
    var labels = GmailApp.getUserLabels();
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].getName().toLowerCase() === name.toLowerCase())
        return labels[i];
    }
    throw e;
  }
}

// ------------------------------------------------------------
//  Trigger management
// ------------------------------------------------------------
function createTrigger(minutes) {
  minutes = minutes || getSettings().intervalMinutes || 1;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "runFilters") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("runFilters").timeBased().everyMinutes(minutes).create();
  return true;
}

function getTriggerStatus() {
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === "runFilters";
  });
  if (!triggers.length) return { active: false, label: "Not active" };
  return {
    active: true,
    label: "Every " + (getSettings().intervalMinutes || 1) + " min",
  };
}

function activateTrigger() {
  createTrigger(getSettings().intervalMinutes || 1);
  return "Auto-run activated.";
}

function deactivateTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "runFilters") ScriptApp.deleteTrigger(t);
  });
  return "Auto-run stopped.";
}

function runFiltersNow() {
  runFilters();
  return "Done — check the log for results.";
}

function getStats() {
  var rules = getRules();
  var logs = getLogs();
  var trigger = getTriggerStatus();
  var s = getSettings();
  return {
    totalRules: rules.length,
    activeRules: rules.filter(function (r) {
      return r.enabled !== false;
    }).length,
    recentActions: logs.length,
    triggerActive: trigger.active,
    triggerLabel: trigger.label,
    intervalMinutes: s.intervalMinutes || 1,
  };
}
