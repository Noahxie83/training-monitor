import { spawn } from 'node:child_process';
import path from 'node:path';
import electron from 'electron';
const child = spawn(electron, [path.resolve('dist/main.cjs'), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => { console.error(error); process.exit(1); });
