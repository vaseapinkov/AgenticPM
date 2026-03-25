#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const net = require('net');

const command = process.argv[2];
const BOARD_DIR = path.join(process.cwd(), 'agent-board');
const CONFIG_FILE = path.join(BOARD_DIR, 'board.config.json');
const TASKS_FILE = path.join(BOARD_DIR, 'tasks.json');
const GITIGNORE_FILE = path.join(BOARD_DIR, '.gitignore');

function detectRepoName() {
  const pkg = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkg)) {
    try { return JSON.parse(fs.readFileSync(pkg, 'utf8')).name; } catch {}
  }
  const composer = path.join(process.cwd(), 'composer.json');
  if (fs.existsSync(composer)) {
    try { return JSON.parse(fs.readFileSync(composer, 'utf8')).name?.split('/').pop(); } catch {}
  }
  return path.basename(process.cwd());
}

function findFreePort(preferred) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferred || 0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      const s2 = net.createServer();
      s2.listen(0, () => {
        const port = s2.address().port;
        s2.close(() => resolve(port));
      });
    });
  });
}

async function init() {
  if (fs.existsSync(BOARD_DIR)) {
    console.log('✓ agent-board/ already exists in this repo.');
    console.log('  Run: agent-board start');
    return;
  }

  const repoName = detectRepoName();
  const port = await findFreePort(3333);

  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ repoName, port, createdAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(TASKS_FILE, JSON.stringify([], null, 2));
  fs.writeFileSync(GITIGNORE_FILE, '# Agent Board - local only, do not commit\ntasks.json\n');

  console.log(`\n✅ Agent Board initialized for: ${repoName}`);
  console.log(`   Directory: agent-board/`);
  console.log(`   Port:      ${port}`);
  console.log(`   tasks.json is git-ignored\n`);
  console.log(`Run: agent-board start\n`);
}

async function start() {
  if (!fs.existsSync(BOARD_DIR)) {
    console.error('\n❌ No agent-board/ found in this directory.');
    console.error('   Run: agent-board init\n');
    process.exit(1);
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    console.error('\n❌ Missing board.config.json — try agent-board init again.\n');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const port = await findFreePort(config.port);

  if (port !== config.port) {
    console.log(`⚠  Port ${config.port} was taken, using ${port} instead.`);
    config.port = port;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }

  require('../lib/server.js')({
    port: config.port,
    repoName: config.repoName,
    tasksFile: TASKS_FILE,
    boardDir: BOARD_DIR
  });
}

function help() {
  console.log(`
  agent-board — local AI agent task board

  Commands:
    init    Initialize agent-board/ in the current repo
    start   Start the board server for this repo
    help    Show this message
`);
}

switch (command) {
  case 'init':   init();  break;
  case 'start':  start(); break;
  case 'help':
  case '--help':
  case '-h':     help();  break;
  default:
    if (!command) {
      if (fs.existsSync(BOARD_DIR)) { start(); } else { help(); }
    } else {
      console.error(`\n  Unknown command: ${command}\n`);
      process.exit(1);
    }
}