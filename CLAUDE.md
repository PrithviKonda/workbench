# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Product Overview

Workbench is a TypeScript Electron desktop app where users describe a goal and the **Claude Code CLI** does the work
autonomously. Every task runs in its own git worktree so the main branch stays safe.

**Core workflow:** User creates a task (description, images, connectors, git options) → a short Claude Code **triage**
run picks model, effort and whether to plan → Claude Code **plans** (plan mode, optional) → **implements** in the task's
worktree (same session, permission checks off) → **validates** (project checks + fresh-context review + commit) → user
reviews, requests changes (same session continues) or merges.

**Main features:**

- **Autonomous Tasks** — Each task is delegated to Claude Code (`claude -p`) in its worktree; Claude Code decides
  when to use subagents, skills, MCP tools and its task list
- **Kanban Board** — Visual task management from planning through completion
- **Agent Terminals** — Parallel AI-powered terminals (12 by default, up to 24) with task context injection
- **Insights** — Chat for exploring a codebase (runs through Claude Code; can't change files) that can also manage
  the project's tasks: Workbench's task tools (`src/main/insights/task-tools.ts`, served over local MCP HTTP by
  `task-tools-server.ts` with a token per chat turn) create, edit, start, stop, retry, move, review, PR, merge, archive
  and delete tasks through the same IPC handlers as the UI (`ipc-handlers/ipc-registry.ts`); ideas the user didn't ask
  for stay task suggestions (`__TASK_SUGGESTION__`)
- **Pull Requests** — Create a GitHub pull request from a task's worktree and merge it (via the `gh` CLI). A task with
  an open PR stays in Human Review (PR Created); Merge PR (`src/main/ai/runners/github/pr-merger.ts`) pulls the target
  branch into the task branch, lets the merge agent (`src/main/ai/runners/merge-agent.ts`, Claude Code) resolve
  conflicts, checks that no line the target added was lost, pushes and merges the PR, then moves the task to Done
- **Connectors** — MCP servers added to a task's Claude Code session (`--mcp-config`: Context7, Electron, Puppeteer,
  user-added servers) with app-wide defaults in Settings and per-task choices in the task dialog
- **Graphify memory graph** — Optional [Graphify](https://github.com/Graphify-Labs/graphify) knowledge graph of a
  project's code, built into `.workbench/knowledge` and offered to agents
- **Isolated Workspaces** — Git worktree isolation for every build; AI-powered semantic merge
- **Authentication** — Claude subscription accounts (each a `CLAUDE_CONFIG_DIR`) or API profiles with any
  Anthropic-compatible endpoint
- **Multi-Account Swapping** — When one Claude account hits a rate limit, switch to an available one automatically
- **Cross-Platform** — Windows, macOS, and Linux with auto-updates

## Critical Rules

**Agent CLIs only** — All AI work (tasks, triage, Insights, titles, PR text, commit messages, merge conflict help)
runs through the locally installed Claude Code CLI via `src/main/claude-code/`. Use `ClaudeTaskRun` for tasks and
`runClaudeText()` for one-shot calls; never call the Anthropic API or an AI SDK directly for these.

**Codex engine** — The same calls can run on OpenAI's Codex CLI (ChatGPT or OpenAI API key), chosen by
`AppSettings.aiEngine` (`auto` default: Claude Code when a Claude account can run, else Codex). `resolveClaudeEnv()`
returns `engine`; `startClaudeProcess()` then translates the Claude Code arguments to `codex exec` and Codex's JSONL
back into Claude Code stream messages (`claude-code/codex.ts`), so callers keep building Claude Code arguments. Codex
accounts are CODEX_HOME folders (`claude-profile/codex-accounts.ts`, `ClaudeProfile.provider: 'codex'`, ids
`codex:<folder>`) with usage from Codex's session files; a session never moves between engines (`ClaudeRunInfo.engine`).

**i18n required** — All user-facing text uses `react-i18next` translation keys (see [i18n](#i18n)).

**Platform abstraction** — Never use `process.platform` directly. Import from `src/main/platform/` (see
[Cross-Platform](#cross-platform)).

**No console.log in production code** — `console.log` output is invisible in bundled Electron apps. Log errors in the
main process with `appLog` (`src/main/app-logger.ts`, written to the logs folder); reserve `console.log` for development
only.

**No time estimates** — Provide priority-based ordering instead of duration predictions.

**PR target** — Always target the `main` branch for PRs; it is the only long-lived branch.

**Never block the main process** — IPC handlers reachable from the UI must not run synchronous child processes
(`execFileSync`/`execSync`) or network calls; use async `execFile` (promisified). A sync `git fetch` used to freeze the
whole app every time a dialog opened.

**Don't re-fetch on open** — Pages and dialogs show stored values (Zustand stores, settings, or
`src/renderer/lib/refresh-cache.ts` for results of slow checks) and only fetch when the user presses a refresh
button, or once when nothing was fetched before. Shared hook: `useProjectBranches()` (it lists local refs
again in the background, never `git fetch`, so branches made outside the app show up).

## Work Approach: Orchestrator-First

You are an orchestrator. Your primary role is to understand what needs to be done, break it into workstreams, and
delegate execution to agent teams. This keeps your context window focused on coordination and decision-making rather
than filling up with implementation details.

<orchestrator_pattern>
When given a task, follow this pattern:

1. **Investigate first** — Read the actual code before forming any hypothesis. Use targeted searches (Glob, Grep, Read)
   for simple lookups. For broader exploration, spawn an Explore agent.

2. **Plan the approach** — Identify what needs to change, which files are involved, and whether work can be
   parallelized. For multi-step tasks, create a task list to track workstreams.

3. **Delegate execution** — Spawn agent teams to do the implementation work. Each agent gets a clear, self-contained
   assignment with all the context it needs: relevant file paths, the specific change to make, and acceptance criteria.
   Run independent workstreams in parallel.

4. **Verify and integrate** — Review agent outputs, run tests, and ensure changes work together. Fix integration issues
   or spawn follow-up agents as needed.
</orchestrator_pattern>

**When to delegate vs. do directly:**

- Delegate: multi-file changes, research across the codebase, independent parallel workstreams, tasks that would consume
  significant context
- Do directly: single-file edits, simple bug fixes, quick lookups, tasks where you already have the context

**Giving agents good assignments** — Each agent works with a fresh context. Include: the specific goal, relevant file
paths, code patterns to follow, and what "done" looks like.

**Minimal changes only** — Prefer the simplest approach (e.g., prompt-only changes, single guard clause) before
suggesting multi-component solutions. If the user asks for X, implement X — don't bundle additional fixes they didn't
request.

**Default to action** — When the user's intent implies making changes, implement them rather than only suggesting. If
something is unclear, read the relevant code to fill in the gaps rather than asking. Only ask when genuine ambiguity
remains about what the user wants.

## Commands

```bash
npm install            # Install dependencies (postinstall rebuilds native modules; on Linux it also fixes chrome-sandbox)
npm run dev            # Development mode with HMR and remote debugging on port 9222 (Electron MCP)
npm test               # Type check (strict) + all tests (Vitest)
```

### Packaging

| Command                 | Output                                           |
|-------------------------|--------------------------------------------------|
| `npm run package:mac`   | macOS `.dmg` + `.zip`                            |
| `npm run package:win`   | Windows `.exe` (NSIS installer)                  |
| `npm run package:linux` | Linux `.deb`                                     |

Packages are written to `dist/`.

### Releases

Releases are created by hand on GitHub, never by a workflow. Publishing a release runs `release.yml`; publishing a
pre-release runs `beta-release.yml`. Each one builds the four platforms in a matrix (`npm ci`, `npm run build`,
`npm run package:*`), takes the version from the release tag (`package.json` keeps the plain base version, and the beta
workflow adds `-beta` when the tag has no pre-release suffix) and uploads the installers and update manifests to that
release with `gh release upload`.

Builds are unsigned and not notarized: the repo holds no signing secrets. Auto-update against a private release repo
also needs `UPDATER_GH_TOKEN` passed to `npm run build`, which no workflow does today.

## Project Structure

```
workbench/
├── src/
│   ├── main/                # Electron main process
│   │   ├── claude-code/     # Claude Code CLI integration (task runner, triage, one-shot calls, inventory)
│   │   ├── ai/              # Remaining helpers: runners (PR, commit, merge help), merge/, project/
│   │   ├── worktree/        # Task worktree creation
│   │   ├── insights/        # Insights chat through Claude Code
│   │   ├── agent/           # AgentManager: starts/stops Claude Code task runs, relays events
│   │   ├── claude-profile/  # Multi-profile credentials, token refresh, usage
│   │   ├── terminal/        # PTY daemon, lifecycle, CLI integration
│   │   ├── platform/        # Cross-platform abstraction
│   │   ├── ipc-handlers/    # IPC handler modules by domain
│   │   └── services/        # App services (session recovery, rate-limit resume)
│   ├── preload/             # Preload scripts (electronAPI bridge)
│   ├── renderer/            # React UI (components, stores, contexts, hooks, styles)
│   └── shared/              # Shared types, i18n, constants, utils
├── resources/               # App and tray icons, macOS entitlements
└── .github/                 # Workflows and the postinstall script
```

## Claude Code Layer (`src/main/claude-code/`)

- **Task runner** (`task-runner.ts`, `ClaudeTaskRun`) — runs one task in its worktree:
  - `triage` (`triage.ts`): read-only `claude -p --json-schema` run → `TaskTriage` (model `haiku|sonnet|opus|fable`,
    effort `low…max`, needsPlan, scope, title, verification commands). Rules follow Claude Code's model-config and
    best-practices docs; Settings > Claude Code can fix model/effort or force planning on/off.
  - `plan`: `--permission-mode plan` + structured plan (headless plan mode has no `ExitPlanMode`), saved to `plan.md`.
  - `implement`: resumes the same session (`--resume`) with `--dangerously-skip-permissions` (worktree isolation;
    without a worktree it uses `--permission-mode auto`) and the triage model/effort.
  - `validate`: same session runs checks, reviews the diff with fresh eyes (`/code-review` or a subagent), commits,
    returns a structured `ValidationReport`. `revise` mode applies "request changes" feedback, then validates again.
  - State in `<specDir>/claude_run.json` (`ClaudeRunInfo`: session id, triage, plan, phases with cost, `system/init`
    info, subagents, validation) so stopped / rate-limited runs continue; logs in `task_logs.json`. Claude Code's
    task list (TaskCreate/TaskUpdate, enabled with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`) is mirrored as the task's subtasks.
- **One-shot calls** (`run-text.ts`, `runClaudeText`) — `claude -p --output-format json --no-session-persistence`, tools
  off unless asked, optional `--json-schema`.
- **Process + env** (`process.ts`, `env.ts`) — async spawn, stream-json parsing (`stream-types.ts`), best available
  Claude profile (rate-limit aware) or the active API profile.
- **Inventory** (`inventory.ts`) — subagents, skills, commands, hooks, MCP servers, CLAUDE.md and settings files that
  Claude Code loads for a project (Settings > Claude Code).
- **AgentManager** (`src/main/agent/agent-manager.ts`) — creates the worktree, builds the run config (attachments,
  connectors, Graphify, settings) and relays run events (`log`, `execution-progress`, `task-event`, `run-info`,
  `subtasks`, `run-finished`) to the IPC layer and the XState task machine.

Claude Code docs: https://code.claude.com/docs/en/ (CLI reference, headless mode, sub-agents, model config,
permission modes, worktrees, hooks, skills).

### Task Directory

Each task's `.workbench/tasks/XXX-name/` contains `task_metadata.json`, `implementation_plan.json` (status and
mirrored task list), `claude_run.json`, `task_logs.json`, `plan.md` (when planned) and `attachments/`.

### Task Changelog (parallel tasks)

Task hooks (`src/main/task-hooks.ts`, `taskHooks.on('state' | 'files-edited', ...)`) run on every state a task
enters (state machine transitions and manual moves) and on the files its Claude Code session edits (Edit, Write,
MultiEdit, NotebookEdit tool calls). `src/main/task-changelog-writer.ts` turns them into the project's
`.workbench/changelog.jsonl` (one JSON entry per line; state entries carry every file the task's branch changes).
At every phase, `buildParallelTasksPrompt()` (`src/main/task-changelog.ts`) adds a "Parallel tasks" section to the
task's system prompt: the other tasks with unmerged changes and the files they touch, so Claude Code can stay clear of
them and avoid merge conflicts.

### MCP Connectors

Settings > Connectors (`settings.mcpConnectors`, `McpConnectorSettings`) holds the defaults: Context7, Electron and
Puppeteer, plus custom servers, which must pass a connection test before they can be switched on. New tasks copy the
enabled ids into `TaskMetadata.mcpConnectors` and can change them in the task dialog. When a task runs,
`buildMcpConfig()` (`src/main/claude-code/mcp-config.ts`) turns that task's ids into `--mcp-config` for its Claude Code
session, on top of the user's own Claude Code MCP configuration. Helpers live in `src/shared/utils/mcp-connectors.ts`.

### Graphify Memory Graph

`src/main/graphify.ts` detects the `graphify` CLI (PyPI package `graphifyy`; status, version and install on
Settings > Updates) and builds a project's graph with `graphify extract <project> --code-only --out
.workbench/knowledge` (Settings > Project > Knowledge index), writing `graphify-out/graph.json`, `GRAPH_REPORT.md` and an
`index.json` summary. The project's "Use Graphify" switch (Project page) is on while `.workbench/knowledge` exists
(`isGraphifyEnabled()`); switching it on builds the graph (the switch is disabled while a build from the app runs,
`memory-graph-store.ts`), switching it off stops a running build and removes the folder, which hides the Graph item. While it is on,
task runs and the Claude page (Insights) get `GRAPHIFY_OUT`, the graphify CLI on `PATH` and a prompt section about
graphify's search commands (Insights limits Bash to those commands). Installing Graphify also adds its `/graphify` skill to Claude Code (`graphify install` for
`~/.claude` and each Claude profile's config dir, after an install or update), and agent windows
get `GRAPHIFY_OUT` and an `--append-system-prompt` hint pointing `/graphify` at `.workbench/knowledge`.

### Electron MCP (testing the app from a task)

Run `npm run dev` and switch on Electron in Settings > Connectors (or in the task's connectors). Claude Code can
then drive the running app over the Chrome DevTools Protocol with `get_electron_window_info`, `take_screenshot`,
`send_command_to_electron`, and `read_electron_logs`.

## Frontend

**Stack:** Electron 40, React 19, TypeScript (strict), Claude Code CLI, Zustand 5, Tailwind CSS v4, Radix UI,
xterm.js 6, electron-vite 5 (Vite 7), Vitest 4 + React Testing Library + jsdom, Motion.

**Path aliases:** `@/*` → `src/renderer/*`, `@shared/*` → `src/shared/*`, `@preload/*` → `src/preload/*`.

**State (Zustand)** — Renderer stores live in `src/renderer/stores/` (`project-store.ts`, `task-store.ts`,
`terminal-store.ts`, `settings-store.ts`, `insights-store.ts`, `context-store.ts`, `kanban-settings-store.ts`,
`terminal-font-settings-store.ts`). Main-process stores: `src/main/project-store.ts`,
`src/main/terminal-session-store.ts`.

**Styling** — Tailwind CSS v4 via `@tailwindcss/postcss`; `clsx` + `tailwind-merge` through `cn()`; variants with
`class-variance-authority`. One color theme (**Default**, `src/shared/constants/themes.ts`) with light/dark variants
via CSS custom properties in `src/renderer/styles/globals.css`. Elements with a `hover:` (or focus/highlight) style get
the pointer cursor automatically from a base rule.

**Fonts** — Bundled in `src/renderer/assets/fonts/`: Anthropic Sans (UI), Dank Mono (terminals and agent windows,
loaded with the FontFace API before xterm measures), Anthropic Serif (sidebar "Workbench" title only) and Inter
(optional interface font). Settings > General > Appearance picks the interface and command line fonts.

**Settings UI (claude.ai style)** — The dialog (`settings/AppSettings.tsx`) has one menu: General, Accounts, Agents,
Project, Connectors, Developer, Updates (Project is the selected project's page: Project, Knowledge, Tasks, Branches).
The project's `useClaudeMd`, `maxBudgetUsd` (budget per task) and `claudeProfileId` (its Claude account;
unset = the account in use) are kept in the project's own `.workbench/settings.json` (`src/main/project-store.ts`). Build pages from `SettingsSection` +
`SettingsRows`/`SettingsRow`; controls are switches, `SegmentedControl`, borderless selects, or dropdown menus with
`SETTINGS_MENU_TRIGGER_CLASS` (no collapsible rows). UI copy conventions: sentence case, no em dashes, no trailing
period in setting descriptions, and no green check / red x status icons (state the status in text).

**IPC** — Handlers in `src/main/ipc-handlers/` (by domain), safe APIs exposed in `src/preload/`, renderer calls
`window.electronAPI.*`.

**Agent management** (`src/main/agent/`) — `agent-manager.ts` (starts, stops and restarts Claude Code task runs and
relays their events), `agent-state.ts` (profile/session assignment for account swapping).

**Claude profiles** (`src/main/claude-profile/`) — `credential-utils.ts` (OS keychain), `token-refresh.ts` (OAuth
refresh), `usage-monitor.ts` (usage and rate limits), `profile-scorer.ts` (profile selection). On every start,
`claude-code-detection.ts` finds Claude Code's own setups (`~/.claude`, `CLAUDE_CONFIG_DIR`, `~/.claude-*`: subscription
sign-in, cloud provider, API key or gateway, from managed settings, the dir's `settings.json` and the environment) and
lists them as accounts (`ClaudeProfile.detected`): usable and renamable, never removed. Claude Code's default `~/.claude`
runs without `CLAUDE_CONFIG_DIR`, keeps its sign-in in `~/.claude.json` and its plain keychain entry
(`config-dir-paths.ts`).

**Terminals** (`src/main/terminal/`) — `pty-daemon.ts` / `pty-manager.ts` (PTY processes), `terminal-lifecycle.ts`,
`cli-integration-handler.ts`. Renderer uses xterm.js 6 with WebGL, fit, web-links, and serialize addons.

## i18n

English is the only supported language. Translation files: `src/shared/i18n/locales/en/*.json`.

**Namespaces:** `common`, `navigation`, `settings`, `dialogs`, `tasks`, `taskReview`, `terminal`, `errors`,
`welcome`.

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation(['navigation', 'common']);

<span>{t('navigation:items.kanban')}</span>          // CORRECT
<span>Kanban</span>                                   // WRONG
<span>{t('errors:task.parseError', { error })}</span> // With interpolation
```

## Cross-Platform

Supports Windows, macOS, and Linux; CI runs tests on all three. Use `src/main/platform/`:

| Function                                  | Purpose                           |
|-------------------------------------------|-----------------------------------|
| `isWindows()` / `isMacOS()` / `isLinux()` | OS detection                      |
| `getPathDelimiter()`                      | `;` (Win) or `:` (Unix)           |
| `findExecutable(name)`                    | Cross-platform executable lookup  |
| `requiresShell(command)`                  | `.cmd/.bat` shell detection (Win) |
| `joinPaths(...parts)`                     | Platform-correct path joining     |

### Shell runtime (Windows: PWSH or WSL)

On Windows, Settings > General > Shell (`AppSettings.windowsShell`, `'pwsh'` by default, applied after a restart)
chooses where Workbench runs everything: natively with PowerShell agent windows (`pwsh.exe`, falling back to
Windows PowerShell 5.1), or inside WSL (the default distro). `src/main/platform/shell-runtime.ts`
(`initShellRuntime()` at startup, `whenShellRuntimeReady()`, `isWslRuntime()`, `getWslInfo()`,
`toRuntimePath()` / `toHostPath()`) holds the active runtime; `wsl-detect.ts` checks availability and probes the
distro once (user, home, login shell and PATH, mount root, networking, interop, tool paths). When WSL can't
start, the session runs natively and the Settings row says why. These modules are not re-exported from `platform/index.ts`.

- **Start tools through `runTool` / `spawnTool` / `killRuntimeProcess`** (`platform/runtime-exec.ts`) and git
  through `git()` (`utils/git-exec.ts`), never `execFile(getToolPath(...))` or a literal `'git'` spawn (an
  architecture test fails on those). In WSL mode they run `wsl.exe -d <distro> --cd <dir> --exec ...`, translate
  whole-argument Windows paths, and pass changed env vars through `WSLENV` (never PATH); in pwsh mode they behave
  as a plain spawn. `getToolPath()` and `getToolInfoAsync()` describe tools (Linux paths in WSL mode), they don't
  run them.
- **Stored paths stay Windows paths** (projects, worktrees, profile config dirs, the WSL Claude home as
  `\\wsl.localhost\<distro>\home\<user>`); translate only at process boundaries (args, cwd, env, prompt text,
  git output such as `worktree list --porcelain`).
- **Claude home:** use `getClaudeHome()` / `expandClaudeHome()` / `joinClaudeHome()` / `claudeProjectSlug()`
  (`platform/claude-home.ts`), not `os.homedir()`. WSL accounts live in the Linux home with file-only credentials
  and their own profile store (`claude-profiles.wsl.json`).
- **Agent windows** know their `shellKind` (`'cmd' | 'powershell' | 'posix'`); command builders in
  `terminal/cli-integration-handler.ts` and `shared/utils/shell-escape.ts` choose syntax from it, not from
  `isWindows()`. WSL windows type bash syntax (wrapped in `bash -c` when the login shell is fish).
- **WSL2 NAT networking** can't reach the app's `127.0.0.1`: Insights task tools go through a stdio bridge
  (`insights/task-tools-bridge.cjs`) run as a Windows process through interop, and the Live agent hook command has
  a WSL branch. Watchers poll `\\wsl.localhost` paths (`fs.watch` fails there).
- **Worktrees** use relative links only when both runtimes' git is 2.48 or newer; on a runtime switch,
  `worktree/runtime-switch.ts` repairs every project's worktrees in the background.

## Known Gotchas

**Electron path resolution** — Paths often differ between dev and packaged builds (`app.isPackaged`,
`process.resourcesPath`). In dev, `__dirname` is `out/main`; in production, bundled assets live under
`process.resourcesPath`. Verify both contexts.

<!-- workbench:project-memory:start -->
Preferences learned in past sessions: @.workbench/compeng/MEMORY.md
<!-- workbench:project-memory:end -->
