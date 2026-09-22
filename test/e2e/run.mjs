// Opens VS Code (the installed one if present) with a throwaway profile, loads DockDB like F5, then runs test/e2e/suite.js.
import { runTests } from '@vscode/test-electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockdb-e2e-'));
const workspace = process.env.DOCKDB_WORKSPACE ?? root;
process.env.DOCKDB_REPORT ??= path.join(tmp, 'report.json');

try {
  await runTests({
    vscodeExecutablePath: fs.existsSync(installed) ? installed : undefined,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test/e2e/suite.js'),
    launchArgs: [workspace, '--user-data-dir', path.join(tmp, 'profile'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
    extensionTestsEnv: { DOCKDB_REPORT: process.env.DOCKDB_REPORT },
  });
} finally {
  if (fs.existsSync(process.env.DOCKDB_REPORT)) {
    const { results } = JSON.parse(fs.readFileSync(process.env.DOCKDB_REPORT, 'utf8'));
    for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} (${r.ms}ms)\n    ${[].concat(r.detail).join('\n    ')}`);
  }
}
