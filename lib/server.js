const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { takeScreenshots } = require('./screenshot');

module.exports = function startServer({ port, repoName, tasksFile, boardDir }) {
  const app = express();
  let sseClients = [];

  const screenshotsDir    = path.join(boardDir, 'screenshots');
  const settingsFile      = path.join(boardDir, 'settings.json');
  const brainstormsFile   = path.join(boardDir, 'brainstorms.json');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  app.use(cors());
  app.use(express.json());
  app.use('/screenshots', express.static(screenshotsDir));

  function serveIndex(req, res) {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    res.set('Cache-Control', 'no-store');
    res.send(html
      .replaceAll('__API_URL__', `http://localhost:${port}`)
      .replaceAll('__REPO_NAME__', repoName)
      .replaceAll('__PORT__', String(port)));
  }
  app.get('/', serveIndex);
  app.get('/index.html', serveIndex);
  app.use(express.static(path.join(__dirname, '../public'), { index: false }));

  const DEFAULT_SETTINGS = {
    executor:    'kiro',
    reviewer:    'kiro',
    screenshots: true,
    maxRetries:  3,
    autoCommit:  true,
    githubToken: ''
  };

  function loadSettings() {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings(s) { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); }

  function load() {
    try { return JSON.parse(fs.readFileSync(tasksFile, 'utf8')); }
    catch { return []; }
  }
  function save(tasks) { fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2)); }

  function loadBrainstorms() {
    try { return JSON.parse(fs.readFileSync(brainstormsFile, 'utf8')); }
    catch { return []; }
  }
  function saveBrainstorms(bs) { fs.writeFileSync(brainstormsFile, JSON.stringify(bs, null, 2)); }

  function patchBrainstorm(brainstormId, patch) {
    const brainstorms = loadBrainstorms();
    const bs = brainstorms.find(b => b.id === brainstormId);
    if (!bs) return null;
    Object.assign(bs, patch, { updatedAt: new Date().toISOString() });
    saveBrainstorms(brainstorms);
    broadcast('brainstorm-updated', bs);
    return bs;
  }

  // ── Exploration Agent ───────────────────────────────────────────

  function runExplorationAgent(brainstormId) {
    return new Promise((resolve) => {
      const repoRoot = path.dirname(boardDir);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
      const prompt = `You are a codebase exploration agent. Analyze this repository and produce a concise structured summary. Output ONLY the sections below, nothing else:

PROJECT OVERVIEW: What this project does (1-2 sentences)

TECH STACK: Languages, frameworks, key dependencies (comma-separated)

KEY FILES: The most important files and what they contain (one per line, format: path — purpose)

PATTERNS: Architectural patterns, conventions, coding style (2-3 sentences)`;

      const proc = spawn('claude',
        ['--print', '--dangerously-skip-permissions'],
        { shell: true, cwd: repoRoot, env }
      );
      proc.stdin.write(prompt);
      proc.stdin.end();

      let output = '';
      proc.stdout.on('data', d => { output += d.toString(); });
      proc.on('close', () => {
        // Parse sections from output
        const section = (name) => {
          const re = new RegExp(`${name}:\\s*(.+?)(?=\\n[A-Z ]+:|$)`, 's');
          return (output.match(re) || [])[1]?.trim() || '';
        };
        const ctx = {
          explored: true,
          summary: section('PROJECT OVERVIEW'),
          structure: section('KEY FILES'),
          techStack: section('TECH STACK')
        };
        patchBrainstorm(brainstormId, { codebaseContext: ctx });
        resolve(ctx);
      });
      proc.on('error', () => {
        patchBrainstorm(brainstormId, {
          codebaseContext: { explored: true, summary: 'Exploration unavailable — claude CLI not found', structure: '', techStack: '' }
        });
        resolve(null);
      });
    });
  }

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(r => r.write(msg));
  }

  function appendLog(taskId, line) {
    const tasks = load();
    const t = tasks.find(t => t.id === taskId);
    if (!t) return;
    if (!t.log) t.log = '';
    t.log += line + '\n';
    save(tasks);
    broadcast('task-updated', t);
  }

  function patchTask(taskId, patch) {
    const tasks = load();
    const t = tasks.find(t => t.id === taskId);
    if (!t) return;
    Object.assign(t, patch);
    save(tasks);
    broadcast('task-updated', t);
    return t;
  }

  // ── Brainstorm Conversation Engine ────────────────────────────────

  function buildAlexSystemPrompt(bs) {
    const ctx = bs.codebaseContext || {};
    const codebaseSection = ctx.explored && ctx.summary
      ? `\nCODEBASE CONTEXT (for your internal reference ONLY — use this when writing task descriptions, but NEVER mention files, code, or technical details in conversation with the user):
${ctx.summary}
${ctx.techStack ? 'Tech Stack: ' + ctx.techStack : ''}
${ctx.structure ? 'Key Files:\n' + ctx.structure : ''}`
      : '';

    return `You are Alex, a senior Product Manager. You conduct structured product discovery interviews — warm, curious, non-technical in conversation. You speak business language with clients.
${codebaseSection}

RESPONSE FORMAT:
You MUST respond with ONLY a valid JSON object. No text before or after the JSON. No markdown code fences.

There are 4 response types:

1. DISCOVERY QUESTION (use during Phase 1):
{"type":"question","context":"1-2 sentence acknowledgment of what the user just said","question":"your single focused question","progress":{"current":N,"total":T,"label":"what you're exploring"},"suggestions":["option 1","option 2","option 3"]}

2. CHAT (when the user asks YOU a question or you need to discuss something):
{"type":"chat","content":"your conversational response"}

3. SCOPE SUMMARY (when discovery is complete, before generating tasks):
{"type":"summary","content":"1-paragraph summary of everything you've understood about the project scope"}

4. TASK LIST (after user confirms the summary):
{"type":"tasks","epics":[{"epic":"Epic Name","goal":"Why this epic exists","tasks":[{"title":"Task title","description":"Technical description for developers","acceptanceCriteria":["Testable condition 1","Testable condition 2"],"dependencies":["Other task name or None"],"complexity":"XS"}]}]}

PHASE 1 — DISCOVERY:

After the user's first message, assess the complexity and decide how many questions you need (between 2 and 5). Set progress.total to that number.

- Simple, clear requests (e.g. "set up Docker for local dev") → 2-3 questions max. Focus on what's ambiguous.
- Vague or complex requests (e.g. "rebuild our auth") → 4-5 questions.
- If the user's initial message already answers some questions, skip those. Don't ask about things that are obvious from context.

In your FIRST question response, briefly tell the user how many questions you have, e.g. "I just have a couple of questions to make sure I get this right."

CRITICAL: Do NOT pad with unnecessary questions. If you have enough to write good tasks after 2 answers, move to summary. Never ask a question just to fill a quota.

Rules:
- ONE question per message.
- "suggestions" should be 2-4 short, specific options. Not generic.
- If the user's answer covers multiple areas, jump ahead in progress.
- If the user asks you something, respond with type=chat. Next turn, return to discovery.
- If the user says "skip", "that's enough", or "generate tasks", immediately send type=summary.

PHASE 2 — DELIVERY:
- First send type=summary. Wait for confirmation.
- After user confirms, send type=tasks with the full task breakdown.
- In task descriptions: BE technical. Use the codebase context. Reference files, frameworks, patterns.
- In conversation (type=question, type=chat): stay NON-technical. Speak business language.

After the task list, the system will show import buttons automatically.`;
  }

  function runBrainstormAgent(prompt, brainstormId) {
    return new Promise((resolve) => {
      const repoRoot = path.dirname(boardDir);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
      const proc = spawn('claude',
        ['--print', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
        { shell: true, cwd: repoRoot, env }
      );
      proc.stdin.write(prompt);
      proc.stdin.end();

      let output = '';
      let streamBuffer = '';

      proc.stdout.on('data', d => {
        d.toString().split('\n').forEach(line => {
          if (!line.trim()) return;
          try {
            const evt = JSON.parse(line);
            if (evt.type === 'assistant' && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === 'text' && block.text) {
                  output += block.text;
                  streamBuffer += block.text;
                  // Broadcast streaming chunks for live typing
                  broadcast('brainstorm-streaming', { id: brainstormId, chunk: block.text });
                }
              }
            } else if (evt.type === 'result') {
              // Don't append result — it duplicates assistant text
            }
          } catch {
            output += line + '\n';
          }
        });
      });

      proc.on('close', () => resolve(output.trim()));
      proc.on('error', () => resolve('I apologize, but I was unable to process that. Could you try rephrasing?'));
    });
  }

  function parseTasksFromOutput(text) {
    const epics = [];
    let currentEpic = null;
    let currentTask = null;
    let currentField = null;

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('EPIC:')) {
        currentEpic = { epic: trimmed.replace('EPIC:', '').trim(), tasks: [] };
        epics.push(currentEpic);
        currentTask = null;
        currentField = null;
      } else if (trimmed.startsWith('GOAL:') && currentEpic) {
        // Store but don't need to track separately
      } else if (trimmed.startsWith('TASK:') && currentEpic) {
        currentTask = {
          title: trimmed.replace('TASK:', '').trim(),
          description: '', acceptanceCriteria: [],
          dependencies: [], complexity: 'M', selected: true
        };
        currentEpic.tasks.push(currentTask);
        currentField = null;
      } else if (trimmed.startsWith('DESCRIPTION:') && currentTask) {
        currentTask.description = trimmed.replace('DESCRIPTION:', '').trim();
        currentField = 'description';
      } else if (trimmed.startsWith('ACCEPTANCE CRITERIA:') && currentTask) {
        currentField = 'criteria';
      } else if (trimmed.startsWith('DEPENDENCIES:') && currentTask) {
        const deps = trimmed.replace('DEPENDENCIES:', '').trim();
        currentTask.dependencies = deps.toLowerCase() === 'none' ? [] : deps.split(',').map(d => d.trim()).filter(Boolean);
        currentField = null;
      } else if (trimmed.startsWith('COMPLEXITY:') && currentTask) {
        currentTask.complexity = trimmed.replace('COMPLEXITY:', '').trim().toUpperCase() || 'M';
        currentField = null;
      } else if (currentField === 'criteria' && currentTask && trimmed.startsWith('-')) {
        currentTask.acceptanceCriteria.push(trimmed.replace(/^-\s*/, ''));
      } else if (currentField === 'description' && currentTask && trimmed && !trimmed.startsWith('ACCEPTANCE')) {
        currentTask.description += ' ' + trimmed;
      }
    }
    return epics;
  }

  async function brainstormTurn(brainstormId, userMessage) {
    const brainstorms = loadBrainstorms();
    const bs = brainstorms.find(b => b.id === brainstormId);
    if (!bs) return null;

    // Append user message
    bs.messages.push({
      id: uuidv4(), role: 'user', content: userMessage,
      timestamp: new Date().toISOString()
    });
    // Auto-set title from first user message
    if (bs.messages.filter(m => m.role === 'user').length === 1) {
      bs.title = userMessage.slice(0, 80) + (userMessage.length > 80 ? '...' : '');
    }
    bs.updatedAt = new Date().toISOString();
    saveBrainstorms(brainstorms);
    broadcast('brainstorm-updated', bs);

    // Build full prompt with conversation history
    const systemPrompt = buildAlexSystemPrompt(bs);
    const history = bs.messages
      .filter(m => m.role !== 'system')
      .map(m => `${m.role === 'user' ? 'USER' : 'ALEX'}: ${m.content}`)
      .join('\n\n');

    const fullPrompt = `${systemPrompt}\n\n--- CONVERSATION ---\n\n${history}\n\nALEX:`;

    // Run agent
    const output = await runBrainstormAgent(fullPrompt, brainstormId);

    // Append assistant message
    const reloaded = loadBrainstorms();
    const bsNow = reloaded.find(b => b.id === brainstormId);
    if (!bsNow) return null;

    // Try to parse structured JSON from Alex
    let structured = null;
    const jsonText = output.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    // Try direct parse first
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && parsed.type) structured = parsed;
    } catch {
      // Try to extract first JSON object from output (might have surrounding text)
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed && parsed.type) structured = parsed;
        } catch {}
      }
    }

    const msg = {
      id: uuidv4(), role: 'assistant',
      content: structured ? JSON.stringify(structured) : output,
      structured: structured || { type: 'chat', content: output },
      timestamp: new Date().toISOString()
    };
    bsNow.messages.push(msg);

    // If tasks were generated, populate generatedTasks
    if (structured?.type === 'tasks' && structured.epics) {
      bsNow.generatedTasks = structured.epics;
    } else if (!structured && output.includes('EPIC:') && output.includes('TASK:')) {
      // Legacy plain-text fallback
      bsNow.generatedTasks = parseTasksFromOutput(output);
    }

    bsNow.updatedAt = new Date().toISOString();
    saveBrainstorms(reloaded);
    broadcast('brainstorm-updated', bsNow);
    return bsNow;
  }

  // ── Task Agent Pipeline ─────────────────────────────────────────

  function runAgent(agentType, prompt, taskId, label) {
    return new Promise((resolve) => {
      const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
      const repoRoot = path.dirname(boardDir);
      const isClaude = agentType === 'claude';
      let cmd, args, spawnOpts;

      if (isClaude) {
        cmd = 'claude';
        args = ['--print', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
        // Filter CLAUDECODE env var to prevent nested session errors
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
        spawnOpts = { shell: true, cwd: repoRoot, env };
      } else {
        const safe = prompt.replace(/'/g, "'\\''");
        cmd = 'kiro-cli';
        args = ['chat', '--no-interactive', '--trust-all-tools', `'${safe}'`];
        spawnOpts = { shell: true, cwd: repoRoot };
      }

      appendLog(taskId, `[${ts()}] [${label}] starting (${agentType})...`);
      const proc = spawn(cmd, args, spawnOpts);

      // Pass prompt via stdin for claude (avoids shell escaping and length limits)
      if (isClaude) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }
      let output = '';
      let resolved = false;

      // Heartbeat so the UI shows the agent is still alive
      const heartbeat = setInterval(() => {
        if (!resolved) appendLog(taskId, `[${label}] ⏳ still working...`);
      }, 30000);

      proc.stdout.on('data', d => {
        d.toString().split('\n').forEach(line => {
          if (!line.trim()) return;
          if (isClaude) {
            // Parse stream-json events from claude
            try {
              const evt = JSON.parse(line);
              if (evt.type === 'assistant' && evt.message?.content) {
                for (const block of evt.message.content) {
                  if (block.type === 'text' && block.text) {
                    output += block.text + '\n';
                    block.text.split('\n').forEach(l => { if (l.trim()) appendLog(taskId, `[${label}] ${l}`); });
                  } else if (block.type === 'tool_use') {
                    const inp = block.input || {};
                    const detail = inp.file_path || inp.command || inp.pattern || inp.description || '';
                    appendLog(taskId, `[${label}] 🔧 ${block.name}${detail ? ': ' + detail.slice(0, 120) : ''}`);
                  }
                }
              } else if (evt.type === 'tool_result') {
                // Show truncated tool output for visibility
                const content = typeof evt.content === 'string' ? evt.content : JSON.stringify(evt.content || '');
                if (content.trim()) {
                  const preview = content.split('\n').filter(l => l.trim()).slice(0, 3).join(' | ');
                  if (preview) appendLog(taskId, `[${label}]   ↳ ${preview.slice(0, 200)}`);
                }
              } else if (evt.type === 'result') {
                output += (evt.result || '') + '\n';
                appendLog(taskId, `[${label}] ✓ Done`);
              }
            } catch {
              // Not JSON — log as-is
              output += line + '\n';
              appendLog(taskId, `[${label}] ${line}`);
            }
          } else {
            output += line + '\n';
            appendLog(taskId, `[${label}] ${line}`);
          }
        });
      });
      proc.stderr.on('data', d => {
        const t = d.toString().trim();
        if (t && !t.startsWith('Warning:') && !t.includes('Electron') && !t.includes('Chromium'))
          appendLog(taskId, `[${label} err] ${t}`);
      });
      proc.on('error', () => {
        clearInterval(heartbeat);
        if (resolved) return;
        resolved = true;
        appendLog(taskId, `[${ts()}] ⚠  ${cmd} not found — demo mode`);
        const steps = ['Reading codebase...','Planning changes...','Writing code...','Verifying...','✅ Done (demo)'];
        let i = 0;
        const iv = setInterval(() => {
          if (i < steps.length) appendLog(taskId, `[${label}] ${steps[i++]}`);
          else { clearInterval(iv); resolve(`Demo output — ${cmd} not installed`); }
        }, 700);
      });
      proc.on('close', code => {
        clearInterval(heartbeat);
        if (resolved) return;
        resolved = true;
        appendLog(taskId, `[${ts()}] [${label}] exited (${code})`);
        resolve(output);
      });
    });
  }

  async function runExecutor(task, settings, retryCtx) {
    const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
    const label = settings.executor === 'claude' ? 'Claude' : 'Kiro';

    if (retryCtx) {
      patchTask(task.id, { status: 'doing' });
      appendLog(task.id, `[${ts()}] 🔄 Retry #${retryCtx.attempt} — addressing: "${retryCtx.reason}"`);
    } else {
      patchTask(task.id, {
        status: 'doing', log: '', agentOutput: '', screenshots: [],
        retryCount: 0, startedAt: new Date().toISOString(),
        usedExecutor: settings.executor, usedReviewer: settings.reviewer,
        usedScreenshots: settings.screenshots, prUrl: null, branch: null
      });
      appendLog(task.id, `[${ts()}] 📋 ${task.title}`);
      if (task.description) appendLog(task.id, `[${ts()}] 📝 ${task.description}`);
      const retryLabel = settings.maxRetries === 0 ? '∞' : settings.maxRetries;
      appendLog(task.id, `[${ts()}] ⚙  ${label} → ${settings.reviewer === 'claude' ? 'Claude' : 'Kiro'} review · screenshots:${settings.screenshots?'on':'off'} · retries:${retryLabel}`);
    }

    let prompt = [task.title, task.description].filter(Boolean).join('\n\n');
    if (retryCtx) {
      prompt += `\n\nPREVIOUS ATTEMPT REJECTED BY REVIEWER.\nReviewer feedback: ${retryCtx.reason}\nPrevious output:\n${retryCtx.previousOutput}\n\nPlease fix the issues above and complete the task correctly.`;
    }

    const output = await runAgent(settings.executor, prompt, task.id, label);
    const tasks = load();
    const t = tasks.find(x => x.id === task.id);
    if (t) { t.agentOutput = output; save(tasks); }
    return output;
  }

  async function runScreenshotStep(task) {
    const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
    appendLog(task.id, `[${ts()}] 📸 Playwright screenshots...`);
    const results = await takeScreenshots(task.id, screenshotsDir, l => appendLog(task.id, l));
    if (results.length > 0) {
      const shots = results.map(r => ({
        viewport: r.viewport, width: r.width, height: r.height,
        url: `/screenshots/${task.id}/${r.viewport}.png`,
        capturedAt: new Date().toISOString()
      }));
      const tasks = load();
      const t = tasks.find(x => x.id === task.id);
      if (t) { t.screenshots = shots; save(tasks); broadcast('task-updated', t); }
      appendLog(task.id, `[${ts()}] ✓ ${shots.length} screenshot(s) ready`);
      return shots;
    }
    return [];
  }

  async function runReviewer(task, settings, attempt) {
    const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
    const label = settings.reviewer === 'claude' ? 'Claude Review' : 'Kiro Review';
    patchTask(task.id, { status: 'checking' });
    appendLog(task.id, `[${ts()}] 🔍 ${label} — attempt ${attempt}...`);

    const shotNote = task.screenshots?.length
      ? `Screenshots: ${task.screenshots.map(s=>`${s.viewport} ${s.width}×${s.height}`).join(', ')}.`
      : 'No screenshots.';
    const execName = task.usedExecutor === 'claude' ? 'Claude Code' : 'Kiro CLI';

    const prompt = `You are a senior code reviewer. ${execName} completed this task (attempt ${attempt}).

REPO: ${repoName}
TASK: ${task.title}${task.description ? `\nDETAILS: ${task.description}` : ''}
${shotNote}

AGENT OUTPUT:
${task.agentOutput || '(none)'}

Check: task fully complete, code clean, no regressions, meets requirements.
ONE line response only:
APPROVED: <one sentence why it passes>
or
REJECTED: <specific what is wrong and exactly what needs fixing>`;

    const output = await runAgent(settings.reviewer, prompt, task.id, label);
    const approved = output.toUpperCase().includes('APPROVED');
    return { approved, reason: output.trim() || (approved ? 'APPROVED: Looks good' : 'REJECTED: Needs revision') };
  }

  function gitRun(args, cwd) {
    try { return execSync(`git ${args}`, { cwd, encoding: 'utf8', timeout: 30000 }).trim(); }
    catch { return null; }
  }

  async function createCommitAndPR(task, settings) {
    const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
    const repoRoot = path.dirname(boardDir);
    appendLog(task.id, `[${ts()}] 🔀 Commit + PR...`);

    if (!gitRun('rev-parse --show-toplevel', repoRoot)) {
      appendLog(task.id, `[${ts()}] ⚠  Not a git repo — skipping`); return null;
    }

    const status = gitRun('status --porcelain', repoRoot);
    if (!status) {
      appendLog(task.id, `[${ts()}] ℹ  No changes to commit — skipping`); return null;
    }

    const safeBranch = `agent-board/${task.id.slice(0,8)}-${task.title
      .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)}`;

    const baseBranch = gitRun('rev-parse --abbrev-ref HEAD', repoRoot) || 'main';
    appendLog(task.id, `[${ts()}] 🌿 Branch: ${safeBranch}`);
    gitRun(`checkout -b ${safeBranch}`, repoRoot);
    gitRun('add -A', repoRoot);

    const msg = task.title.replace(/"/g, '\\"');
    const body = [
      task.description || '',
      `Executor: ${task.usedExecutor === 'claude' ? 'Claude Code' : 'Kiro CLI'}`,
      `Reviewer: ${task.usedReviewer === 'claude' ? 'Claude Code' : 'Kiro CLI'}`,
      task.retryCount > 0 ? `Retries: ${task.retryCount}` : '',
      `Task ID: ${task.id}`
    ].filter(Boolean).join('\n').replace(/"/g, '\\"');

    const committed = gitRun(`commit -m "${msg}" -m "${body}"`, repoRoot);
    if (!committed) { appendLog(task.id, `[${ts()}] ✗ Commit failed`); return null; }
    appendLog(task.id, `[${ts()}] ✓ Committed`);

    gitRun(`push -u origin ${safeBranch}`, repoRoot);
    appendLog(task.id, `[${ts()}] ✓ Pushed`);

    let prUrl = null;

    // Try gh CLI
    try {
      const prBody = `${task.description||''}\n\n---\n**Executor:** ${task.usedExecutor}\n**Reviewer:** ${task.usedReviewer}\n**Retries:** ${task.retryCount||0}\n**Review:** ${task.reviewNote||'Approved'}\n\n_Agent Board_`.replace(/"/g,'\\"');
      const out = execSync(`gh pr create --title "${msg}" --body "${prBody}" --base ${baseBranch}`, { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }).trim();
      prUrl = out.match(/https:\/\/github\.com\/[^\s]+/)?.[0] || out;
      appendLog(task.id, `[${ts()}] ✅ PR: ${prUrl}`);
    } catch {
      // Fallback: GitHub REST API
      if (settings.githubToken) {
        try {
          const remote = gitRun('remote get-url origin', repoRoot) || '';
          const m = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
          if (m) {
            const [owner, repo] = m[1].split('/');
            const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
              method: 'POST',
              headers: { Authorization: `token ${settings.githubToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: task.title, head: safeBranch, base: baseBranch, body: `${task.description||''}\n\nExecutor: ${task.usedExecutor} | Reviewer: ${task.usedReviewer} | Retries: ${task.retryCount||0}\n\n_Agent Board_` })
            });
            const d = await r.json();
            prUrl = d.html_url;
            appendLog(task.id, `[${ts()}] ✅ PR: ${prUrl}`);
          }
        } catch(e) { appendLog(task.id, `[${ts()}] ⚠  PR API error: ${e.message}`); }
      } else {
        appendLog(task.id, `[${ts()}] ℹ  Branch pushed. Install gh CLI or add token in Settings to auto-open PR.`);
      }
    }

    const tasks = load();
    const t = tasks.find(x => x.id === task.id);
    if (t) { t.prUrl = prUrl; t.branch = safeBranch; t.committedAt = new Date().toISOString(); save(tasks); broadcast('task-updated', t); }
    return prUrl;
  }

  // ── Main pipeline ────────────────────────────────────────────────

  async function processTask(taskId) {
    const allTasks = load();
    const task = allTasks.find(t => t.id === taskId);
    if (!task) return;

    const settings = loadSettings();
    const maxRetries = settings.maxRetries; // 0 = unlimited
    let attempt = 0;
    let lastReason = null;
    let lastOutput = null;

    try {
      while (true) {
        attempt++;
        const retryCtx = attempt > 1 ? { attempt, reason: lastReason, previousOutput: lastOutput } : null;
        const fresh = load().find(t => t.id === taskId);

        await runExecutor(fresh, settings, retryCtx);

        if (settings.screenshots) {
          const afterExec = load().find(t => t.id === taskId);
          await runScreenshotStep(afterExec);
        }

        const beforeReview = load().find(t => t.id === taskId);
        const { approved, reason } = await runReviewer(beforeReview, settings, attempt);
        lastOutput = beforeReview.agentOutput;
        lastReason = reason;

        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });

        if (approved) {
          patchTask(taskId, { status: 'done', doneAt: new Date().toISOString(), reviewNote: reason, retryCount: attempt - 1 });
          appendLog(taskId, `[${ts}] 🎉 Approved on attempt ${attempt}`);
          if (settings.autoCommit) {
            const doneTask = load().find(t => t.id === taskId);
            await createCommitAndPR(doneTask, settings);
          }
          break;
        } else {
          patchTask(taskId, { retryCount: attempt, reviewNote: reason });
          const hitLimit = maxRetries > 0 && attempt >= maxRetries;
          if (hitLimit) {
            patchTask(taskId, { status: 'review-failed' });
            appendLog(taskId, `[${ts}] ✗ Failed after ${attempt} attempt(s): ${reason}`);
            break;
          }
          const left = maxRetries === 0 ? '∞' : maxRetries - attempt;
          appendLog(taskId, `[${ts}] ↺ Rejected (${attempt}/${maxRetries === 0 ? '∞' : maxRetries}) — retrying. Left: ${left}`);
          appendLog(taskId, `[${ts}] Reason: ${reason}`);
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch (err) {
      patchTask(taskId, { status: 'error', error: err.message });
      appendLog(taskId, `[ERROR] ${err.message}`);
    }
  }

  // ── REST API ─────────────────────────────────────────────────────

  app.get('/api/tasks', (req, res) => res.json(load()));
  app.get('/api/config', (req, res) => res.json({ repoName, port }));

  app.get('/api/settings', (req, res) => res.json(loadSettings()));
  app.patch('/api/settings', (req, res) => {
    const cur = loadSettings();
    const u = { ...cur };
    if (['kiro','claude'].includes(req.body.executor))  u.executor    = req.body.executor;
    if (['kiro','claude'].includes(req.body.reviewer))  u.reviewer    = req.body.reviewer;
    if (typeof req.body.screenshots === 'boolean')      u.screenshots = req.body.screenshots;
    if (typeof req.body.autoCommit  === 'boolean')      u.autoCommit  = req.body.autoCommit;
    if ([0, 3].includes(Number(req.body.maxRetries)))   u.maxRetries  = Number(req.body.maxRetries);
    if (typeof req.body.githubToken === 'string')       u.githubToken = req.body.githubToken;
    saveSettings(u);
    broadcast('settings-updated', u);
    res.json(u);
  });

  app.post('/api/tasks/:id/commit', async (req, res) => {
    const task = load().find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    if (task.status !== 'done') return res.status(400).json({ error: 'Task must be Done' });
    res.json({ ok: true });
    await createCommitAndPR(task, loadSettings());
  });

  app.post('/api/tasks', (req, res) => {
    const tasks = load();
    const task = {
      id: uuidv4(), title: (req.body.title||'').trim(), description: (req.body.description||'').trim(),
      status: 'backlog', createdAt: new Date().toISOString(),
      log: '', agentOutput: '', reviewNote: '', screenshots: [],
      retryCount: 0, prUrl: null, branch: null
    };
    if (!task.title) return res.status(400).json({ error: 'Title required' });
    tasks.push(task); save(tasks); broadcast('task-created', task); res.json(task);
  });

  app.patch('/api/tasks/:id', (req, res) => {
    const tasks = load();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    const prev = task.status;
    Object.assign(task, req.body); save(tasks); broadcast('task-updated', task);
    if (req.body.status === 'todo' && prev !== 'todo') setTimeout(() => processTask(task.id), 400);
    res.json(task);
  });

  app.delete('/api/tasks/:id', (req, res) => {
    save(load().filter(t => t.id !== req.params.id));
    const shotDir = path.join(screenshotsDir, req.params.id);
    if (fs.existsSync(shotDir)) fs.rmSync(shotDir, { recursive: true });
    broadcast('task-deleted', { id: req.params.id }); res.json({ ok: true });
  });

  // ── Brainstorm API ───────────────────────────────────────────────

  app.get('/api/brainstorms', (req, res) => res.json(loadBrainstorms()));

  app.get('/api/brainstorms/:id', (req, res) => {
    const bs = loadBrainstorms().find(b => b.id === req.params.id);
    if (!bs) return res.status(404).json({ error: 'Not found' });
    res.json(bs);
  });

  app.post('/api/brainstorms', (req, res) => {
    const brainstorms = loadBrainstorms();
    const bs = {
      id: uuidv4(),
      title: (req.body.title || '').trim() || 'New brainstorm',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{
        id: uuidv4(), role: 'assistant',
        content: '{"type":"question","context":"Hey! I\'m Alex — I\'ll be helping turn your idea into something the development team can build. I\'ve kicked off a quick scan of your codebase in the background.","question":"What are you trying to build or solve?","suggestions":["New feature","Set up dev environment","Fix / improve existing feature","Refactor or restructure"]}',
        structured: { type: 'question', context: "Hey! I'm Alex — I'll be helping turn your idea into something the development team can build. I've kicked off a quick scan of your codebase in the background.", question: 'What are you trying to build or solve?', suggestions: ['New feature', 'Set up dev environment', 'Fix / improve existing feature', 'Refactor or restructure'] },
        timestamp: new Date().toISOString()
      }],
      codebaseContext: { explored: false, summary: '', structure: '', techStack: '' },
      generatedTasks: [],
      importedTaskIds: []
    };
    brainstorms.push(bs);
    saveBrainstorms(brainstorms);
    broadcast('brainstorm-created', bs);
    res.json(bs);

    // Kick off exploration agent async
    runExplorationAgent(bs.id).catch(() => {});
  });

  app.post('/api/brainstorms/:id/messages', async (req, res) => {
    const bs = loadBrainstorms().find(b => b.id === req.params.id);
    if (!bs) return res.status(404).json({ error: 'Not found' });
    const msg = (req.body.content || '').trim();
    if (!msg) return res.status(400).json({ error: 'Message required' });
    res.json({ ok: true });
    await brainstormTurn(req.params.id, msg);
  });

  app.delete('/api/brainstorms/:id', (req, res) => {
    saveBrainstorms(loadBrainstorms().filter(b => b.id !== req.params.id));
    broadcast('brainstorm-deleted', { id: req.params.id });
    res.json({ ok: true });
  });

  app.post('/api/brainstorms/:id/import', (req, res) => {
    const brainstorms = loadBrainstorms();
    const bs = brainstorms.find(b => b.id === req.params.id);
    if (!bs) return res.status(404).json({ error: 'Not found' });

    const tasks = load();
    const importedIds = [];
    const selectedIndices = req.body.selected; // array of {epicIdx, taskIdx} or null for all

    // Normalize: handle both flat array and {epic, tasks[]} format
    let epics = bs.generatedTasks || [];
    if (epics.length && !epics[0].tasks) {
      epics = [{ epic: 'Tasks', tasks: epics }];
    }

    for (let ei = 0; ei < epics.length; ei++) {
      const epic = epics[ei];
      const epicTasks = epic.tasks || [];
      for (let ti = 0; ti < epicTasks.length; ti++) {
        const gt = epicTasks[ti];
        if (selectedIndices && !selectedIndices.some(s => s.epicIdx === ei && s.taskIdx === ti)) continue;
        const epicPrefix = epic.epic && epic.epic !== 'Tasks' ? `[${epic.epic}] ` : '';
        const ac = gt.acceptanceCriteria || [];
        const deps = gt.dependencies || [];
        const task = {
          id: uuidv4(),
          title: `${epicPrefix}${gt.title}`,
          description: [
            gt.description || '',
            ac.length ? '\nAcceptance Criteria:\n' + ac.map(c => '- ' + c).join('\n') : '',
            gt.complexity ? `\nComplexity: ${gt.complexity}` : '',
            deps.length ? `Dependencies: ${deps.join(', ')}` : ''
          ].filter(Boolean).join('\n'),
          status: 'backlog', createdAt: new Date().toISOString(),
          log: '', agentOutput: '', reviewNote: '', screenshots: [],
          retryCount: 0, prUrl: null, branch: null
        };
        tasks.push(task);
        importedIds.push(task.id);
        broadcast('task-created', task);
      }
    }

    save(tasks);
    bs.status = 'imported';
    bs.importedTaskIds = importedIds;
    bs.updatedAt = new Date().toISOString();
    saveBrainstorms(brainstorms);
    res.json({ imported: importedIds.length, ids: importedIds });
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('event: connected\ndata: {}\n\n');
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
  });

  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n┌─────────────────────────────────────────┐`);
    console.log(`│  🚀 Agent Board                          │`);
    console.log(`│  Repo:   ${repoName.padEnd(31)}│`);
    console.log(`│  URL:    ${url.padEnd(31)}│`);
    console.log(`└─────────────────────────────────────────┘\n`);
    const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${open} ${url}`);
  });
};