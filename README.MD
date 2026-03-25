# Agent Board ⚡

> A local, per-repo AI agent kanban board. Write a task, move it to Todo — Kiro CLI or Claude Code executes it automatically, Playwright captures screenshots, an AI reviewer checks the output, and a GitHub PR gets opened when it passes.

**Created by [Corneliu Popovici](https://github.com/corneliuspopovici) & [Claude AI](https://claude.ai) · MIT License · Open Source**

---

## What is this?

Agent Board turns your AI coding agents into a proper workflow. Instead of typing prompts into a chat window and manually checking the output, you manage tasks on a Linear-style kanban board. Each task moves through a pipeline automatically:

```
Backlog → Todo → Doing → Checking → Done → PR on GitHub
              ↑       ↑          ↑
           Kiro CLI  Playwright  AI Reviewer
          or Claude  screenshots (Kiro or Claude)
```

Every project gets its own board, its own port, and its own `tasks.json` — completely isolated. You install the CLI once globally and `init` it in as many repos as you want.

---

## Features

- **Linear-style kanban UI** — clean, fast, dark/light/system theme
- **Per-repo isolation** — each project has its own board, port, and task history
- **Kiro CLI + Claude Code support** — choose your executor and reviewer independently
- **Auto-retry with context** — when a review fails, the agent re-runs with the exact rejection reason fed back as context
- **Playwright screenshots** — desktop (1280×800) and mobile (390×844) captured automatically before review
- **GitHub PR integration** — auto-creates a branch, commits, and opens a PR when a task is approved
- **Live log drawer** — click any card to see real-time output from agents
- **Global settings sidebar** — executor, reviewer, screenshot toggle, retry limit, auto-PR, GitHub token
- **No cloud, no login, no telemetry** — runs entirely on your machine

---

## Requirements

| Tool | Purpose | Install |
|---|---|---|
| Node.js 18+ | Runs the board server | [nodejs.org](https://nodejs.org) |
| Kiro CLI | Executes and reviews tasks (optional) | [kiro.dev](https://kiro.dev) |
| Claude CLI | Alternative executor/reviewer (optional) | [docs.anthropic.com](https://docs.anthropic.com/claude-code) |
| `gh` CLI | Creates GitHub PRs (optional) | `brew install gh` |
| Playwright | Screenshots during checking | Installed automatically via `npm install` |

Both Kiro CLI and Claude CLI are optional — Agent Board runs in **demo mode** if neither is installed, simulating the pipeline so you can test the UI first.

---

## Installation

### 1. Clone or download

```bash
git clone https://github.com/corneliupopovici/agent-board.git ~/agent-board
# or download and unzip anywhere on your machine
```

### 2. Install dependencies

```bash
cd ~/agent-board
npm install
```

This also runs `npx playwright install chromium` automatically to download the browser for screenshots.

### 3. Install the CLI globally

```bash
npm install -g .
```

### 4. Fix PATH (macOS — first time only)

If `agent-board` says "command not found" after installing:

```bash
# Find where npm puts global binaries
npm config get prefix
# → e.g. /Users/yourname/.npm-global

# Add to your shell (run once)
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Verify
agent-board help
```

---

## Usage

### Initialize a repo

Run this once inside any project folder:

```bash
cd ~/projects/YourProject
agent-board init
```

Output:

```
✅ Agent Board initialized for: YourProject
   Directory: agent-board/
   Port:      3333
   tasks.json is git-ignored

Run: agent-board start
```

### Start the board

```bash
agent-board start
# → opens http://localhost:3333 automatically
```

### Run multiple repos simultaneously

Each repo gets its own port assigned at init time — no conflicts:

```bash
# Terminal 1
cd ~/projects/YourProject && agent-board start    # → :3333

# Terminal 2
cd ~/projects/YourProject && agent-board start  # → :3788

# Terminal 3
cd ~/projects/YourProject && agent-board start  # → :4102
```

---

## The Pipeline

### Step 1 — Add a task

Type a title and optional description in the topbar, press Enter. Task lands in **Backlog**.

### Step 2 — Run it

Click **▶ Run** on the card. Task moves to **Todo**, agent triggers automatically within 400ms.

### Step 3 — Doing

Your executor (Kiro CLI or Claude Code) receives the task as a prompt and starts working. The card shows a live amber progress bar. Click the card to open the log drawer and watch every line of agent output in real time.

### Step 4 — Checking

Once the executor finishes:

1. **Playwright** opens a headless browser, auto-detects your dev server on common ports (`3000`, `5173`, `4200`, etc.), and captures:
   - Desktop screenshot at 1280×800
   - Mobile screenshot at 390×844 (iPhone viewport)

2. **The reviewer agent** receives the task details, executor output, and screenshot metadata. It responds with exactly one line:
   - `APPROVED: <reason>` → task moves to Done
   - `REJECTED: <specific reason>` → retry

### Step 5 — Auto-retry

When rejected, the executor re-runs immediately with the reviewer's feedback injected into the prompt:

```
PREVIOUS ATTEMPT REJECTED BY REVIEWER.
Reviewer feedback: "The button is missing a hover state and color contrast fails WCAG AA"
Previous output: [previous agent output]

Please fix the issues above and complete the task correctly.
```

This continues until approved or the retry limit is hit. Cards show an amber `↺2` chip showing how many retries were needed.

### Step 6 — Done + GitHub PR

On approval, the board automatically:

1. Creates branch: `agent-board/<taskid>-fix-navbar-better-design`
2. Stages all changed files (`git add -A`)
3. Commits with task title + metadata in commit body
4. Pushes to GitHub
5. Opens a pull request back to your base branch

The PR link appears on the card (`↗ PR`) and in the Review tab of the log drawer.

---

## Settings

All settings live in the sidebar panel and persist to `agent-board/settings.json` per repo.

| Setting | Options | Default | Description |
|---|---|---|---|
| ⚡ Executor | Kiro / Claude | Kiro | Which CLI executes tasks |
| 🔍 Reviewer | Kiro / Claude | Kiro | Which CLI reviews output |
| ↺ Retries | 3× / ∞ | 3× | Auto-retry limit on rejection |
| 📸 Screenshots | On / Off | On | Playwright screenshots during checking |
| 🔀 Auto PR | On / Off | On | Auto commit + PR when task is Done |
| 🔑 GH Token | Text field | — | GitHub PAT (only if `gh` CLI not installed) |

Settings take effect on the next task run. Tasks already in-flight use the settings they started with.

---

## GitHub PR Setup

### Option A — `gh` CLI (recommended)

```bash
brew install gh
gh auth login
```

Done. Agent Board calls `gh pr create` automatically.

### Option B — GitHub Personal Access Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Create a token with `repo` scope
3. Paste it into the **🔑 GH Token** field in the sidebar

The token is saved to `agent-board/settings.json` which is git-ignored.

---

## File Structure

### The global tool (install once, anywhere)

```
~/agent-board/
  bin/
    agent-board.js      ← CLI entry point
  lib/
    server.js           ← Express backend + full pipeline
    screenshot.js       ← Playwright screenshot helper
  public/
    index.html          ← Frontend (single-file, zero build step)
  package.json
  README.md
```

### Per repo (created by `agent-board init`)

```
your-project/
  agent-board/
    board.config.json   ← Repo name + port. ✅ Commit this.
    tasks.json          ← Your task list.   🚫 Git-ignored.
    settings.json       ← Your settings.    🚫 Git-ignored.
    .gitignore          ← Auto-created.     ✅ Commit this.
    screenshots/
      <taskId>/
        desktop.png
        mobile.png
```

---

## Commands

```bash
agent-board init      # Initialize agent-board/ in current repo
agent-board start     # Start the board server for this repo
agent-board help      # Show help
agent-board           # Auto-starts if agent-board/ exists here
```

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Browser (index.html)                                 │
│  Linear-style kanban — SSE for live task updates      │
└─────────────────────┬────────────────────────────────┘
                      │ HTTP + Server-Sent Events
┌─────────────────────▼────────────────────────────────┐
│  Express Server (lib/server.js)                       │
│                                                       │
│  Pipeline per task:                                   │
│  1. runExecutor()     → kiro-cli or claude --print    │
│  2. runScreenshots()  → Playwright (screenshot.js)    │
│  3. runReviewer()     → kiro-cli or claude --print    │
│  4. retry loop        → feeds rejection reason back   │
│  5. createCommitAndPR() → git + gh CLI / GitHub API   │
│                                                       │
│  Storage: tasks.json + settings.json (flat JSON)      │
└─────────────────────┬────────────────────────────────┘
                      │ spawn() with cwd = repo root
         ┌────────────┴────────────┐
         ▼                         ▼
  kiro-cli / claude CLI       Playwright
  (sees your full codebase)   (headless Chromium)
```

---

## Troubleshooting

### "command not found: agent-board"

npm global bin isn't in PATH. Fix:

```bash
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### "Server offline on port XXXX"

The board server isn't running. Open a terminal in your project folder and run `agent-board start`. Keep it open while using the board.

If the port is taken by another process:

```bash
rm agent-board/board.config.json
agent-board init   # assigns a fresh port
```

### Tasks show "demo mode" instead of running Kiro

Kiro CLI is not installed or not in PATH:

```bash
kiro-cli --version   # should print a version
# if not found: install from kiro.dev
```

Same check applies to `claude` CLI if you're using Claude as executor.

### Playwright screenshots not capturing

Make sure your dev server is running before triggering tasks. Agent Board scans these ports:

```
3000, 3001, 4000, 4200, 5173, 5174, 8080, 8000, 8888, 4321
```

To add a custom port, edit `COMMON_PORTS` in `lib/screenshot.js`.

To reinstall Playwright browsers:

```bash
cd ~/agent-board
npx playwright install chromium
```

### PR not being created

Check `gh` CLI auth:

```bash
gh auth status
```

Or add a GitHub personal access token in the Settings sidebar as fallback.

### "Changes to server.js aren't taking effect"

After editing source files you must reinstall the global CLI:

```bash
cd ~/agent-board
npm install -g .
```

---

## Contributing

PRs welcome. This is a practical tool built for real daily use — if you extend it, consider sharing back.

```bash
git clone https://github.com/corneliupopovici/agent-board.git
cd agent-board
npm install
# Edit lib/server.js, public/index.html, or lib/screenshot.js
npm install -g .   # reinstall to test your changes
```

Ideas for contributions:
- Tablet viewport option (768×1024)
- Task tagging and filtering by tag
- Export task history to markdown or CSV
- Support for Kiro steering files and custom agents
- Windows shell compatibility improvements
- Multi-page Playwright navigation (scroll, click, capture)

---

## License

```
MIT License

Copyright (c) 2026 Corneliu Popovici & Claude AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

<p align="center">
  Built by <a href="https://github.com/corneliuspopovici">Corneliu Popovici</a> & <a href="https://claude.ai">Claude AI</a>
  &nbsp;·&nbsp;
 
  &nbsp;·&nbsp;
  MIT License
</p>