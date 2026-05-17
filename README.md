# Gmail Filter App

A Google Apps Script app for building custom Gmail filtering rules with a simple UI.

It lets you:

- scan selected Gmail areas like `Inbox`, `Spam`, `Trash`, `Sent`, or `Everywhere`
- create multi-condition rules using `AND` / `OR`
- match email `From`, `To`, `Subject`, and `Body`
- choose between `Exact` matching and `Regex`
- automatically `trash`, `archive`, `label`, `star`, `mark read`, or `delete`
- review activity logs and debug why a rule matched

The app runs on a time trigger in the background and keeps checking for new emails based on your configured interval.

## How It Works

You create rules in the UI.

Each rule can contain one or more conditions, for example:

- `From` exactly matches `canopy.ua@gmail.com`
- `Body` regex matches `\blet me in\b`

When a message matches a rule, the selected action is applied to that message.

Rules run from top to bottom, so order matters.

## Install

1. Go to [script.google.com](https://script.google.com).
2. Create a new Apps Script project.
3. Replace the default files with this project:
   - copy `Code.gs`
   - copy `Ui.html`
4. Save the project.
5. Enable the Gmail advanced service if you are prompted to do so.
   - In Apps Script: `Services` → add `Gmail API`
6. Run the app once from Apps Script so Google can request permissions.
7. Authorize access to your Gmail.
8. Open the web app UI and create your rules.
9. Activate auto-run so it keeps working in the background.

After authorization, it can run silently in the background on the configured schedule.

## First Run

Recommended setup:

1. Create one simple rule first.
2. Use `Exact` mode unless you specifically need regex.
3. Use `Test` before enabling a destructive action.
4. Use `🐛 Debug` if a rule behaves unexpectedly.
5. Start with `archive`, `label`, or `mark read` before using `trash` or `delete`.

## Matching Modes

Each condition has two modes:

- `Exact`
  - matches literal text
  - safest default
  - good for exact sender emails, fixed phrases, or specific subjects
- `Regex`
  - uses normal regular expression rules
  - useful for flexible matching patterns
  - example: `.*@gmail\.com`

Case options:

- `case insensitive`
- `case sensitive`
- `multiline` for regex only

`multiline` means `^` and `$` can match the start and end of each line, not only the whole field.

## Example Rules

Exact sender plus exact phrase:

- `From` → `Exact` → `canopy.ua@gmail.com`
- `Body` → `Exact` → `let me in`
- Logic: `AND`

Regex sender:

- `From` → `Regex` → `.*@gmail\.com`

Whole word in body:

- `Body` → `Regex` → `\blet me in\b`

Multiple spam keywords:

- `Subject` → `Regex` → `sale|promo|deal`

## Rule Actions

Available actions include:

- move to trash
- permanently delete
- archive
- add label
- add label and archive
- add label and trash
- star
- mark read

## Pattern Tips

- Use `Exact` unless you really need regex.
- In regex, `.` means any character.
- In regex, `\.` means a literal dot.
- For body rules, be careful with replies: old quoted text can still appear in the body.
- Combine body rules with a `From` condition when possible.

## Debugging

If something matches unexpectedly:

1. Open the rule.
2. Use `Test` to check recent matching messages.
3. Use `🐛 Debug` to inspect why each condition passed or failed.
4. Check `Activity Log` to see which rule matched and what action ran.

## Notes

- The app works on messages, not entire conversations, for actions triggered by rules.
- Rules are evaluated in order from top to bottom.
- Drag and drop can be used to reorder rules.
- Background execution depends on Apps Script triggers and Google quotas.

## Security / Permissions

The script needs Gmail access because it reads messages and applies actions like trashing, archiving, labeling, and marking read.

Only install it in a Google account you control and trust.

## Project Files

- `Code.gs`: server-side Apps Script logic
- `Ui.html`: web UI
