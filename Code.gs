// ============================================================
//  Gmail Filter App — Code.gs  (v2)
//  Paste this entire file into your Apps Script project
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

function saveSettings(settings) {
  PropertiesService.getUserProperties().setProperty(
    SETTINGS_KEY,
    JSON.stringify(settings),
  );
  return true;
}

function updateInterval(minutes) {
  minutes = parseInt(minutes, 10);
  var allowed = [1, 5, 10, 15, 30];
  if (allowed.indexOf(minutes) === -1) throw new Error("Invalid interval");
  var settings = getSettings();
  settings.intervalMinutes = minutes;
  saveSettings(settings);
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
  rules.push(rule);
  saveRules(rules);
  return rule;
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

// ------------------------------------------------------------
//  Log storage
// ------------------------------------------------------------
function getLogs() {
  var raw = PropertiesService.getUserProperties().getProperty(LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

function appendLog(entry) {
  var logs = getLogs();
  logs.unshift(entry);
  if (logs.length > MAX_LOG) logs = logs.slice(0, MAX_LOG);
  PropertiesService.getUserProperties().setProperty(
    LOG_KEY,
    JSON.stringify(logs),
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
//  Test a pattern
// ------------------------------------------------------------
function testPattern(field, pattern, flags, scope) {
  try {
    var regex = new RegExp(pattern, flags || "i");
    var scopeQuery = buildScopeQuery(scope && scope.length ? scope : ["inbox"]);
    var threads = GmailApp.search(scopeQuery, 0, 30);
    var matches = [];
    threads.forEach(function (thread) {
      var msg = thread.getMessages()[0];
      var val = getFieldValue(msg, field);
      if (regex.test(val)) {
        matches.push({
          from: msg.getFrom(),
          subject: msg.getSubject(),
          date: msg.getDate().toISOString(),
        });
      }
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

  var since = new Date(Date.now() - 7 * 60 * 1000);
  var ts = Math.floor(since.getTime() / 1000);

  // group by scope query to minimise GmailApp.search calls
  var queryMap = {};
  rules.forEach(function (rule) {
    var q = buildScopeQuery(rule.scope);
    if (!queryMap[q]) queryMap[q] = [];
    queryMap[q].push(rule);
  });

  Object.keys(queryMap).forEach(function (scopeQuery) {
    var scopeRules = queryMap[scopeQuery];
    var threads = GmailApp.search(scopeQuery + " after:" + ts, 0, 200);

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        scopeRules.forEach(function (rule) {
          try {
            var regex = new RegExp(rule.pattern, rule.flags || "i");
            if (!regex.test(getFieldValue(msg, rule.field))) return;

            applyAction(thread, msg, rule);

            saveRules(
              getRules().map(function (r) {
                if (r.id === rule.id) r.hits = (r.hits || 0) + 1;
                return r;
              }),
            );

            appendLog({
              ts: new Date().toISOString(),
              ruleId: rule.id,
              name: rule.name || rule.pattern,
              action: rule.action,
              from: msg.getFrom(),
              subject: msg.getSubject(),
            });
          } catch (e) {
            appendLog({
              ts: new Date().toISOString(),
              ruleId: rule.id,
              name: rule.name || rule.pattern,
              action: "ERROR",
              from: msg.getFrom(),
              subject: e.message,
            });
          }
        });
      });
    });
  });
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
      thread.moveToTrash();
      try {
        Gmail.Users.Threads.remove("me", thread.getId());
      } catch (e) {
        appendLog({
          ts: new Date().toISOString(),
          ruleId: rule.id,
          name: rule.name,
          action: "WARN",
          from: "",
          subject: "Delete Failed: " + e.message,
        });
      }
      break;

    case "archive":
      thread.moveToArchive();
      break;

    case "label":
      var lbl =
        GmailApp.getUserLabelByName(rule.label) ||
        GmailApp.createLabel(rule.label);
      thread.addLabel(lbl);
      break;

    case "label+archive":
      var lbl2 =
        GmailApp.getUserLabelByName(rule.label) ||
        GmailApp.createLabel(rule.label);
      thread.addLabel(lbl2);
      thread.moveToArchive();
      break;

    case "trash+label":
      thread.moveToTrash();
      var lbl3 =
        GmailApp.getUserLabelByName(rule.label) ||
        GmailApp.createLabel(rule.label);
      thread.addLabel(lbl3);
      break;

    case "star":
      msg.star();
      break;

    case "markread":
      thread.markRead();
      break;
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
  var settings = getSettings();
  return {
    active: true,
    label: "Every " + (settings.intervalMinutes || 1) + " min",
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
  var settings = getSettings();
  return {
    totalRules: rules.length,
    activeRules: rules.filter(function (r) {
      return r.enabled !== false;
    }).length,
    totalActions: logs.length,
    triggerActive: trigger.active,
    triggerLabel: trigger.label,
    intervalMinutes: settings.intervalMinutes || 1,
  };
}
