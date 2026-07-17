import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerEntry = resolve(projectRoot, 'apps', 'whatsapp-worker', 'dist', 'index.js');
let child;
let stopping = false;
let restartTimer;

function startWorker() {
  child = spawn(process.execPath, ['--env-file=.env.motor.local', workerEntry], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: false,
  });

  child.once('exit', (code, signal) => {
    child = undefined;
    if (stopping) return;
    const reason = signal ? `sinal ${signal}` : `codigo ${code ?? 'desconhecido'}`;
    console.error(`[supervisor] WhatsApp worker encerrou com ${reason}. Reiniciando em 3 segundos...`);
    restartTimer = setTimeout(startWorker, 3_000);
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child && !child.killed) child.kill(signal);
  else process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startWorker();
