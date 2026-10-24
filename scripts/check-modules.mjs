// Static checks for the browser modules (no build step, so we verify here):
//   - every file parses as an ES module
//   - every relative import points at a real file
//   - every named import is actually exported by that file
// Run with: npm run check
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'js');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.js')) files.push(full);
  }
})(root);

const exportsOf = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(s => names.add(s.split(/\s+as\s+/).pop().trim()));
  }
  exportsOf.set(f, names);
}

let problems = 0;
const tmp = mkdtempSync(join(tmpdir(), 'modcheck-'));
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = relative(root, f);

  // syntax
  const copy = join(tmp, rel.replace(/[\\/]/g, '__') + '.mjs');
  writeFileSync(copy, src);
  try {
    execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
  } catch (e) {
    problems++;
    console.error(`✗ ${rel}: syntax error\n${String(e.stderr).split('\n').slice(0, 6).join('\n')}`);
  }

  // static imports
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(f), m[3]);
    if (!exportsOf.has(target)) {
      problems++;
      console.error(`✗ ${rel}: cannot resolve ${m[3]}`);
      continue;
    }
    if (m[1]) {
      problems++;
      console.error(`✗ ${rel}: default import from ${m[3]} (modules only use named exports)`);
    }
    const wanted = (m[2] || '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/)[0].trim());
    for (const name of wanted) {
      if (!exportsOf.get(target).has(name)) {
        problems++;
        console.error(`✗ ${rel}: "${name}" is not exported by ${m[3]}`);
      }
    }
  }
  // dynamic imports
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const target = resolve(dirname(f), m[2]);
    if (!exportsOf.has(target)) {
      problems++;
      console.error(`✗ ${rel}: cannot resolve dynamic import ${m[2]}`);
      continue;
    }
    for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (!exportsOf.get(target).has(name)) {
        problems++;
        console.error(`✗ ${rel}: "${name}" is not exported by ${m[2]}`);
      }
    }
  }
}
rmSync(tmp, { recursive: true, force: true });

if (problems) {
  console.error(`\n${problems} problem(s) in ${files.length} modules`);
  process.exit(1);
}
console.log(`✓ ${files.length} modules parse and their imports line up`);
