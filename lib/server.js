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

  const screenshotsDir = path.join(boardDir, 'screenshots');
  const settingsFile   = path.join(boardDir, 'settings.json');
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

  const VALID_MODELS = [
    'kiro:claude-opus-4.6', 'kiro:claude-sonnet-4.6', 'kiro:claude-opus-4.5', 'kiro:claude-sonnet-4.5',
    'kiro:claude-sonnet-4', 'kiro:claude-haiku-4.5', 'kiro:deepseek-3.2',
    'kiro:minimax-m2.5', 'kiro:minimax-m2.1', 'kiro:qwen3-coder-next',
    'claude:opus', 'claude:sonnet'
  ];

  const DEFAULT_SETTINGS = {
    planner:     'kiro:claude-opus-4.6',
    executor:    'kiro:claude-opus-4.6',
    reviewer:    'kiro:claude-opus-4.6',
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

  const MODEL_LABELS = {
    'kiro:claude-opus-4.6': 'Kiro (Opus 4.6)', 'kiro:claude-sonnet-4.6': 'Kiro (Sonnet 4.6)',
    'kiro:claude-opus-4.5': 'Kiro (Opus 4.5)', 'kiro:claude-sonnet-4.5': 'Kiro (Sonnet 4.5)',
    'kiro:claude-sonnet-4': 'Kiro (Sonnet 4)', 'kiro:claude-haiku-4.5': 'Kiro (Haiku 4.5)',
    'kiro:deepseek-3.2': 'Kiro (DeepSeek 3.2)', 'kiro:minimax-m2.5': 'Kiro (MiniMax M2.5)',
    'kiro:minimax-m2.1': 'Kiro (MiniMax M2.1)', 'kiro:qwen3-coder-next': 'Kiro (Qwen3 Coder)',
    'claude:opus': 'Claude Code (Opus)', 'claude:sonnet': 'Claude Code (Sonnet)'
  };

  function resolveAgent(model) {
    const label = MODEL_LABELS[model] || model;
    if (model?.startsWith('claude:')) return { type: 'claude', model, label };
    return { type: 'kiro', model, label };
  }

  // Map kiro model setting to kiro-cli --model flag value
  const KIRO_MODEL_MAP = {
    'kiro:claude-opus-4.6': 'claude-opus-4.6', 'kiro:claude-sonnet-4.6': 'claude-sonnet-4.6',
    'kiro:claude-opus-4.5': 'claude-opus-4.5', 'kiro:claude-sonnet-4.5': 'claude-sonnet-4.5',
    'kiro:claude-sonnet-4': 'claude-sonnet-4', 'kiro:claude-haiku-4.5': 'claude-haiku-4.5',
    'kiro:deepseek-3.2': 'deepseek-3.2', 'kiro:minimax-m2.5': 'minimax-m2.5',
    'kiro:minimax-m2.1': 'minimax-m2.1', 'kiro:qwen3-coder-next': 'qwen3-coder-next'
  };

  function runAgent(agentModel, prompt, taskId, labelOverride) {
    return new Promise((resolve) => {
      const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
      const repoRoot = path.dirname(boardDir);
      const { type: agentType, label: agentLabel } = resolveAgent(agentModel);
      const label = labelOverride || agentLabel;
      const isClaude = agentType === 'claude';
      let cmd, args, spawnOpts;

      if (isClaude) {
        cmd = 'claude';
        args = ['--print', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
        if (agentModel === 'claude:sonnet') args.push('--model', 'claude-sonnet-4-20250514');
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE'));
        spawnOpts = { shell: true, cwd: repoRoot, env };
      } else {
        const safe = prompt.replace(/'/g, "'\\''");
        cmd = 'kiro-cli';
        const kiroModel = KIRO_MODEL_MAP[agentModel] || 'claude-opus-4.6';
        args = ['chat', '--no-interactive', '--trust-all-tools', '--model', kiroModel, `'${safe}'`];
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

  async function runPlanner(task, settings) {
    const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
    const { label } = resolveAgent(settings.planner);

    patchTask(task.id, {
      status: 'planning', log: '', agentOutput: '', screenshots: [],
      retryCount: 0, startedAt: new Date().toISOString(),
      usedPlanner: settings.planner, usedExecutor: settings.executor, usedReviewer: settings.reviewer,
      usedScreenshots: settings.screenshots, prUrl: null, branch: null, plan: ''
    });

    appendLog(task.id, `[${ts()}] 📋 ${task.title}`);
    if (task.description) appendLog(task.id, `[${ts()}] 📝 ${task.description}`);
    appendLog(task.id, `[${ts()}] 🧠 Planning with ${label}...`);

    const prompt = `You are a senior software architect. Analyze the following task and the codebase, then produce a detailed implementation plan.

REPO: ${repoName}
TASK: ${task.title}${task.description ? `\nDETAILS: ${task.description}` : ''}

Your plan MUST include:
1. Analysis of which files need to be changed and why
2. Step-by-step implementation changes with specific file paths
3. Any new files that need to be created
4. Edge cases and potential issues to watch for
5. Testing considerations

Output a clear, numbered implementation plan that an executor agent can follow precisely.`;

    const output = await runAgent(settings.planner, prompt, task.id, `Planner (${label})`);
    const tasks = load();
    const t = tasks.find(x => x.id === task.id);
    if (t) { t.plan = output; save(tasks); broadcast('task-updated', t); }
    appendLog(task.id, `[${ts()}] ✓ Plan ready — passing to executor`);
    return output;
  }

  async function runExecutor(task, settings, retryCtx) {
    const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
    const { label } = resolveAgent(settings.executor);

    if (retryCtx) {
      patchTask(task.id, { status: 'doing' });
      appendLog(task.id, `[${ts()}] 🔄 Retry #${retryCtx.attempt} — addressing: "${retryCtx.reason}"`);
    } else {
      patchTask(task.id, { status: 'doing' });
      const retryLabel = settings.maxRetries === 0 ? '∞' : settings.maxRetries;
      appendLog(task.id, `[${ts()}] ⚙  ${label} → ${resolveAgent(settings.reviewer).label} review · screenshots:${settings.screenshots?'on':'off'} · retries:${retryLabel}`);
    }

    let prompt = [task.title, task.description].filter(Boolean).join('\n\n');

    // Include the plan from the planning phase
    const freshTask = load().find(x => x.id === task.id);
    if (freshTask?.plan) {
      prompt += `\n\nIMPLEMENTATION PLAN (from planner):\n${freshTask.plan}\n\nFollow this plan precisely to implement the changes.`;
    }

    if (retryCtx) {
      prompt += `\n\nPREVIOUS ATTEMPT REJECTED BY REVIEWER.\nReviewer feedback: ${retryCtx.reason}\nPrevious output:\n${retryCtx.previousOutput}\n\nPlease fix the issues above and complete the task correctly.`;
    }

    const output = await runAgent(settings.executor, prompt, task.id, `Executor (${label})`);
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
    const { label } = resolveAgent(settings.reviewer);
    patchTask(task.id, { status: 'checking' });
    appendLog(task.id, `[${ts()}] 🔍 ${label} Review — attempt ${attempt}...`);

    const shotNote = task.screenshots?.length
      ? `Screenshots: ${task.screenshots.map(s=>`${s.viewport} ${s.width}×${s.height}`).join(', ')}.`
      : 'No screenshots.';
    const { label: execLabel } = resolveAgent(task.usedExecutor);

    const prompt = `You are a senior code reviewer. ${execLabel} completed this task (attempt ${attempt}).

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

    const output = await runAgent(settings.reviewer, prompt, task.id, `Reviewer (${label})`);
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
      `Planner: ${resolveAgent(task.usedPlanner || 'kiro').label}`,
      `Executor: ${resolveAgent(task.usedExecutor || 'kiro').label}`,
      `Reviewer: ${resolveAgent(task.usedReviewer || 'kiro').label}`,
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
      const prBody = `${task.description||''}\n\n---\n**Planner:** ${task.usedPlanner||'kiro'}\n**Executor:** ${task.usedExecutor}\n**Reviewer:** ${task.usedReviewer}\n**Retries:** ${task.retryCount||0}\n**Review:** ${task.reviewNote||'Approved'}\n\n_Agent Board_`.replace(/"/g,'\\"');
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
              body: JSON.stringify({ title: task.title, head: safeBranch, base: baseBranch, body: `${task.description||''}\n\nPlanner: ${task.usedPlanner||'kiro'} | Executor: ${task.usedExecutor} | Reviewer: ${task.usedReviewer} | Retries: ${task.retryCount||0}\n\n_Agent Board_` })
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
      // Planning phase
      await runPlanner(task, settings);

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
    if (VALID_MODELS.includes(req.body.planner))            u.planner     = req.body.planner;
    if (VALID_MODELS.includes(req.body.executor))           u.executor    = req.body.executor;
    if (VALID_MODELS.includes(req.body.reviewer))           u.reviewer    = req.body.reviewer;
    if (typeof req.body.screenshots === 'boolean')          u.screenshots = req.body.screenshots;
    if (typeof req.body.autoCommit  === 'boolean')          u.autoCommit  = req.body.autoCommit;
    if ([0, 3].includes(Number(req.body.maxRetries)))       u.maxRetries  = Number(req.body.maxRetries);
    if (typeof req.body.githubToken === 'string')           u.githubToken = req.body.githubToken;
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