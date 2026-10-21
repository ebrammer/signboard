# Syllabi Signboard

A focused fork of [Signboard](https://github.com/cdevroe/signboard), based on 1.7.4. The original MIT license and attribution are retained.

## First slice

- An Overview workspace gathers cards from currently open boards, including undated work, with the source project and original workflow lists intact.
- Cooperating card writers serialize updates. Card revisions allow stale writes to fail visibly instead of replacing newer content. Agent body replacements use the revision returned by a fresh read.
- Existing Markdown cards, board directories, labels, custom lists, and Obsidian metadata remain compatible. Opening the overview does not migrate cards.

## Desktop identity and migration

The fork is **Syllabi Signboard**, bundle ID `com.syllabi.signboard`. Its desktop profile is separate from upstream (`Syllabi Signboard` instead of `Signboard` under the OS application-data directory). `SIGNBOARD_USER_DATA_DIR` and `SIGNBOARD_DESKTOP_USER_DATA_DIR` still support isolated tests and explicit MCP configuration.

To adopt existing boards, back up the upstream profile and board folders, quit upstream, copy its profile into the fork's separate profile directory, and launch the fork. The profile copy retains open/trusted board paths; the Markdown stays in place. Only one desktop implementation should write the same cards at a time: an older upstream build does not participate in the new write protocol. External editors similarly do not acquire Signboard's locks.

The `signboard://` scheme and existing links remain compatible. The running fork may register itself as the handler. To roll back, quit the fork, relaunch upstream, and restore its MCP launch configuration; no reverse board migration is required. Do not restore old board backups over newer edits as part of a routine rollback.

Automatic binary updates are disabled, and packaging has no upstream publication target. Pull upstream source changes deliberately, review conflicts, run regressions, and rebuild. This prevents an upstream update from silently replacing fork features.

## Development

Follow `AGENTS.md`, `CODEX.md`, and `docs/codex/TESTING.md`. Edit renderer modules, then run `npm run build:js`; `app/signboard.js` is generated. Retain upstream attribution and maintain a narrow patch set. Local plans, test evidence, and user-specific paths belong under ignored `.local/` or `output/`.

## Compact overview and human requests

Overview starts with compact project summaries. Expand a project for its original lists; completed work stays behind a disclosure. Needs you gathers explicit questions, decisions, and review requests from unfinished cards. A human response resolves the attention request without moving or completing its card.

Project goals and next steps live in the optional `.signboard-project.md` file inside each board. Card coordination uses optional `sb_*` frontmatter alongside existing content. Opening an old board creates neither metadata nor summary files. Desktop and MCP changes use revisions to reject stale writes. Agents should read human responses before resuming and report meaningful milestones rather than continuous activity.
