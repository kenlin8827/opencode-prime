/** Regression coverage for destructive cross-project session cleanup flags. */
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(import.meta.dir, '../install/src/index.ts'), 'utf8');

const allProjectsBranch = /else if \(arg === '--all-projects'\) \{\s*\/\/ Convenience form for `--all --projects`\.\s*args\.cleanAll = true;\s*args\.cleanAllProjects = true;/s;
if (!allProjectsBranch.test(source)) {
  throw new Error('--all-projects must enable both the all-session and cross-project scopes');
}

if (!source.includes("if (args.cleanAllProjects && !args.cleanAll)")) {
  throw new Error('--projects without --all must be rejected');
}

if (!source.includes("args.cleanAllProjects && (args.cleanProject || args.cleanProjectName || args.cleanDirectory)")) {
  throw new Error('cross-project cleanup must reject narrower project or directory scopes');
}

if (!source.includes('args.cleanAll && !args.cleanAllProjects && !args.cleanProject && !args.cleanProjectName ? process.cwd() : undefined')) {
  throw new Error('--all-projects must omit the current-workspace directory filter');
}

console.log('✅ Session clean cross-project flags preserve their destructive-operation safeguards.');
