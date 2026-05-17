// ============================================================
//  Gmail Filter App — Code.gs  (v4)
//  Changes from v3:
//   - Multi-condition rules with AND / OR logic
//   - Rule ordering (moveRule up/down)
//   - Expanded log entries: body snippet + matched conditions
//   - Auto-migration skipped (clean slate as requested)
// ============================================================

var RULES_KEY = "gmail_filter_rules";
var LOG_KEY = "gmail_filter_log";
var SETTINGS_KEY = "gmail_filter_settings";
var MAX_LOG = 100;

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

// Move rule up or down in the ordered list
function moveRule(id, direction) {
  var rules = getRules();
  var idx = -1;
  rules.forEach(function (r, i) {
    if (r.id === id) idx = i;
  });
  if (idx === -1) return false;

  var newIdx = direction === "up" ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= rules.length) return false;

  // swap
  var tmp = rules[idx];
  rules[idx] = rules[newIdx];
  rules[newIdx] = tmp;

  saveRules(rules);
  return true;
}

// ------------------------------------------------------------
//  Log storage
// ------------------------------------------------------------
function getLogs() {
  var raw = PropertiesService.getUserProperties().getProperty(LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

function _flushLogs(newEntries) {
  if (!newEntries.length) return;
  var existing = getLogs();
  var combined = newEntries.concat(existing);
  if (combined.length > MAX_LOG) combined = combined.slice(0, MAX_LOG);
  PropertiesService.getUserProperties().setProperty(
    LOG_KEY,
    JSON.stringify(combined),
  );
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
//  Test a pattern — checks ALL messages in threads
// ------------------------------------------------------------
function testRule(conditions, logic, scope) {
  try {
    var scopeQuery = buildScopeQuery(scope && scope.length ? scope : ["inbox"]);
    var threads = GmailApp.search(scopeQuery, 0, 30);
    var matches = [];

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        if (matches.length >= 30) return;

        var results = conditions.map(function (cond) {
          var regex = new RegExp(cond.pattern, cond.flags || "i");
          var val = getFieldValue(msg, cond.field);
          return {
            field: cond.field,
            pattern: cond.pattern,
            matched: regex.test(val),
          };
        });

        var passed =
          logic === "OR"
            ? results.some(function (r) {
                return r.matched;
              })
            : results.every(function (r) {
                return r.matched;
              });

        if (passed) {
          matches.push({
            from: msg.getFrom(),
            subject: msg.getSubject(),
            date: msg.getDate().toISOString(),
            conditions: results,
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

        scopeRules.forEach(function (rule) {
          try {
            // evaluate each condition and record individual results
            var condResults = (rule.conditions || []).map(function (cond) {
              var regex = new RegExp(cond.pattern, cond.flags || "i");
              var val = getFieldValue(msg, cond.field);
              return {
                field: cond.field,
                pattern: cond.pattern,
                matched: regex.test(val),
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

            if (!passed) return;

            applyAction(thread, msg, rule);

            hitMap[rule.id] = (hitMap[rule.id] || 0) + 1;

            // store body snippet (first 400 chars of plain text)
            var bodySnippet = "";
            try {
              bodySnippet = msg
                .getPlainBody()
                .replace(/\s+/g, " ")
                .trim()
                .substring(0, 400);
            } catch (e) {}

            logsToWrite.push({
              ts: new Date().toISOString(),
              ruleId: rule.id,
              ruleName: rule.name || "Unnamed rule",
              action: rule.action,
              from: msg.getFrom(),
              subject: msg.getSubject(),
              body: bodySnippet,
              conditions: condResults, // which conditions matched/didn't
              logic: rule.logic,
            });
          } catch (e) {
            logsToWrite.push({
              ts: new Date().toISOString(),
              ruleId: rule.id,
              ruleName: rule.name || "Unnamed rule",
              action: "ERROR",
              from: msg.getFrom(),
              subject: e.message,
              body: "",
              conditions: [],
              logic: rule.logic,
            });
          }
        });
      });
    });
  });

  // single write at the end
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

function applyAction(thread, msg, rule) {
  switch (rule.action) {
    case "trash":
      thread.moveToTrash();
      break;
    case "delete":
      try {
        thread.moveToTrash();
        Gmail.Users.Threads.remove("me", thread.getId());
      } catch (e) {
        throw new Error(
          "Permanent delete failed: " + e.message + " — moved to trash instead",
        );
      }
      break;
    case "archive":
      thread.moveToArchive();
      break;
    case "label":
      thread.addLabel(_getOrCreateLabel(rule.label));
      break;
    case "label+archive":
      thread.addLabel(_getOrCreateLabel(rule.label));
      thread.moveToArchive();
      break;
    case "trash+label":
      thread.moveToTrash();
      thread.addLabel(_getOrCreateLabel(rule.label));
      break;
    case "star":
      msg.star();
      break;
    case "markread":
      thread.markRead();
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
