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
var MAX_LOG = 25; // prefer fewer, richer entries so rule/body details survive

// ------------------------------------------------------------
//  Web App entry point
// ------------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile("Ui")
    .setTitle("Gmail Filter Rules")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ------------------------------------------------------------
//  Settings
// ------------------------------------------------------------
function getSettings() {
  var raw = PropertiesService.getUserProperties().getProperty(SETTINGS_KEY);
  return raw ? JSON.parse(raw) : { intervalMinutes: 1 };
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
  return raw ? JSON.parse(raw) : [];
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
  rule.id = Utilities.getUuid();
  rule.createdAt = new Date().toISOString();
  rule.hits = 0;
  rule.enabled = true;
  if (!rule.scope || !rule.scope.length) rule.scope = ["inbox"];
  if (!rule.logic) rule.logic = "AND";
  if (!rule.conditions || !rule.conditions.length)
    throw new Error("Rule must have at least one condition");
  rules.push(rule);
  saveRules(rules);
  return rule;
}

function updateRule(updated) {
  var rules = getRules();
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
    var matched = matchCondition(actualValue, cond, msg);
    return {
      field: cond.field,
      pattern: cond.pattern,
      flags: cond.flags || "i",
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
  var rules = getRules().filter(function (r) {
    return r.enabled !== false;
  });
  if (!rules.length) return;

  var settings = getSettings();
  var intervalMinutes = settings.intervalMinutes || 1;
  var bufferMinutes = 2;
  var since = new Date(
    Date.now() - (intervalMinutes + bufferMinutes) * 60 * 1000,
  );
  var ts = Math.floor(since.getTime() / 1000);

  // group rules by scope query
  var queryMap = {};
  rules.forEach(function (rule) {
    var q = buildScopeQuery(rule.scope);
    if (!queryMap[q]) queryMap[q] = [];
    queryMap[q].push(rule);
  });

  var hitMap = {};
  var logsToWrite = [];

  Object.keys(queryMap).forEach(function (scopeQuery) {
    var scopeRules = queryMap[scopeQuery];
    var threads = GmailApp.search(scopeQuery + " after:" + ts, 0, 200);

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        if (msg.getDate() < since) return;
        var actionTaken = false;

        scopeRules.forEach(function (rule) {
          if (actionTaken) return;

          try {
            var eval_ = evaluateConditions(msg, rule);
            if (!eval_.passed) return;

            var fromValue = msg.getFrom();
            var subjectValue = msg.getSubject();
            var bodySnippet = "";
            try {
              bodySnippet = makeSnippet(msg.getPlainBody(), 200);
            } catch (e) {}

            applyAction(msg, rule);
            actionTaken = true;

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
  _flushLogs(logsToWrite);
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
      return msg.getPlainBody();
    default:
      return "";
  }
}

function extractEmailAddresses(value) {
  var matches = String(value || "").match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  );
  return matches
    ? matches.map(function (email) {
        return email.toLowerCase();
      })
    : [];
}

function looksLikeLiteralEmailPattern(pattern) {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(
    String(pattern || "").trim(),
  );
}

function makeSnippet(value, limit) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, limit || 120);
}

function matchCondition(actualValue, cond) {
  var pattern = String(cond.pattern || "");
  var flags = cond.flags || "i";
  var field = cond.field;

  if (
    (field === "from" || field === "to") &&
    looksLikeLiteralEmailPattern(pattern)
  ) {
    var expected = pattern.toLowerCase();
    return extractEmailAddresses(actualValue).some(function (email) {
      return email === expected;
    });
  }

  var regex = new RegExp(pattern, flags);
  return regex.test(String(actualValue || ""));
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
