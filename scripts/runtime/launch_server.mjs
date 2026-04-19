#!/usr/bin/env node

import { mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeHome = process.env.CLAWTV_HOME || os.homedir();
const supportDir = path.join(runtimeHome, 'Library', 'Application Support', 'ClawTV');
const envFile = path.join(supportDir, 'clawtv.env');
const defaultLogRoot = '/Volumes/LaCie_6big/briansnyder/logs';
const defaultPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function stripMatchingQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function parseEnvFile(filePath) {
  const loaded = {};
  let text = '';

  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return loaded;
    }

    throw error;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith('#')) {
      continue;
    }

    const equalsIndex = rawLine.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, equalsIndex);
    const value = stripMatchingQuotes(rawLine.slice(equalsIndex + 1));
    loaded[key] = value;
  }

  return loaded;
}

function appendLine(fd, message) {
  writeSync(fd, `${new Date().toISOString()} ${message}\n`);
}

const fileEnv = parseEnvFile(envFile);
const logRoot = process.env.CLAWTV_LOG_ROOT || fileEnv.CLAWTV_LOG_ROOT || defaultLogRoot;
const logDir = path.join(logRoot, 'ClawTV');
const childEnv = {
  ...process.env,
  ...fileEnv,
};

if (!childEnv.CLAWTV_BASE_PATH) {
  childEnv.CLAWTV_BASE_PATH = '/ClawTV';
}

if (!childEnv.CLAWTV_DATA_DIR) {
  childEnv.CLAWTV_DATA_DIR = path.join(supportDir, 'data');
}

if (!childEnv.PLEX_BASE_URL) {
  childEnv.PLEX_BASE_URL = 'http://127.0.0.1:32400/';
}

if (!childEnv.PORT) {
  childEnv.PORT = '4390';
}

if (!childEnv.CLAWTV_SERVER_STDOUT_LOG) {
  childEnv.CLAWTV_SERVER_STDOUT_LOG = path.join(logDir, 'server.stdout.log');
}

if (!childEnv.CLAWTV_SERVER_STDERR_LOG) {
  childEnv.CLAWTV_SERVER_STDERR_LOG = path.join(logDir, 'server.stderr.log');
}

if (!childEnv.CLAWTV_RUNTIME_LOG_MAX_BYTES) {
  childEnv.CLAWTV_RUNTIME_LOG_MAX_BYTES = '1000000';
}

if (!childEnv.CLAWTV_RUNTIME_LOG_TRIM_INTERVAL_MINUTES) {
  childEnv.CLAWTV_RUNTIME_LOG_TRIM_INTERVAL_MINUTES = '15';
}

childEnv.PATH = `/opt/homebrew/bin:/usr/local/bin:${childEnv.PATH || defaultPath}`;

mkdirSync(childEnv.CLAWTV_DATA_DIR, { recursive: true });
mkdirSync(path.dirname(childEnv.CLAWTV_SERVER_STDOUT_LOG), { recursive: true });
mkdirSync(path.dirname(childEnv.CLAWTV_SERVER_STDERR_LOG), { recursive: true });

const stdoutFd = openSync(childEnv.CLAWTV_SERVER_STDOUT_LOG, 'a');
const stderrFd = openSync(childEnv.CLAWTV_SERVER_STDERR_LOG, 'a');

appendLine(stdoutFd, '[launch_server] starting ClawTV server');

const child = spawn(
  '/opt/homebrew/bin/node',
  [path.join(repoRoot, 'apps/server/dist/index.js')],
  {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', stdoutFd, stderrFd],
  },
);

child.on('error', (error) => {
  appendLine(stderrFd, `[launch_server] spawn failed: ${error.stack || error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    appendLine(stderrFd, `[launch_server] child exited from signal ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 0);
});

for (const eventName of ['SIGINT', 'SIGTERM']) {
  process.on(eventName, () => {
    if (!child.killed) {
      child.kill(eventName);
    }
  });
}
