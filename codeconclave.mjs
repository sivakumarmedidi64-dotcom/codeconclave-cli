#!/usr/bin/env node
// CodeConClave CLI - use CodeConClave AI from your terminal: chat, make a file, change a file (you see the change and say yes first).
// One file, nothing to install. Needs Node 18 or newer. Sign in with your CodeConClave account (free messages, like the web app), or use an API key.
//
//   node codeconclave.mjs login                       sign in with your account (OK a code in the browser) · login --key: paste an API key
//   node codeconclave.mjs                             chat (type /help inside)
//   node codeconclave.mjs "your question"             one answer
//   node codeconclave.mjs make snake.html "a snake game with a score"
//   node codeconclave.mjs edit app.js "add a dark mode button"
//   node codeconclave.mjs explain server.js
//   git diff | node codeconclave.mjs "review this change"
// The coding agent in this folder (it plans first, you OK each change, every change can be rewound):
//   node codeconclave.mjs do "add a dark mode button" [--yes]   (--yes: no question per file; commands still ask)
//   node codeconclave.mjs rewind            the changes of the last "do" · rewind 3 = back to before change 3
//   node codeconclave.mjs commands          saved commands from .codeconclave/commands/*.md · then: node codeconclave.mjs <name> words
//   Rules for the agent go in CODECONCLAVE.md (or AGENTS.md) in the folder.
// Agents (the same tasks, actions and approvals as the app):
//   status · task create "..." [--type research_report] [--role coder] · task list · task watch <id> · task approve|reject|cancel <id>
//   action list [category] · action run <action_id> '{"key":"value"}' · model list · model route <mode>
//   workspace create <name> · workspace push <ws> [folder] · workspace pull <ws> [folder] · file read|diff <ws> <path>
//   code change <ws> "what to change" · code review <ws> <path> · code test <ws> · mission run "goal" · automation create "every day at 8 am ..."
//   benchmark list · logs follow <task> · stop (emergency stop: cancels all your agents) · start
// Runs (plan -> your OK -> steps -> checks -> report), the same as the Runs page:
//   plan "goal" · run "goal" [--yes] · runs · run show|watch|cancel|pause|resume|retry <id> · approve <id> <code> · deny <id>
//   undo <id> · report <id> [file.pdf] · trace <id> · inbox · activity · actions search "words" · js file.js | js "code" · mcp
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, basename, dirname, resolve, sep } from 'node:path';
import readline from 'node:readline';

const VERSION = '1.4.0';
const BASE = (process.env.CODECONCLAVE_URL || 'https://codeconclave-ww5x.onrender.com').replace(/\/+$/, '');
const CONF = join(homedir(), '.codeconclave.json');
const tty = process.stdout.isTTY;
const c = (n) => (s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const yellow = c('33'), dim = c('2'), green = c('32'), red = c('31'), bold = c('1');
const MAX_FILE = 60000;

function keyOf() {
  if (process.env.CODECONCLAVE_API_KEY) return process.env.CODECONCLAVE_API_KEY.trim();
  try { return String(JSON.parse(readFileSync(CONF, 'utf8')).key || '').trim(); } catch { return ''; }
}
const ask = (q) => new Promise((ok) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); ok(a); }); });
const yes = async (q) => /^y(es)?$/i.test((await ask(q + dim(' (y/n) '))).trim());

// a small animation while the AI works
function spinner(text) {
  if (!tty) return () => {};
  const f = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0; const t0 = Date.now();
  const id = setInterval(() => { process.stdout.write(`\r${yellow(f[i++ % f.length])} ${text} ${dim(Math.round((Date.now() - t0) / 1000) + 's')}   `); }, 90);
  return () => { clearInterval(id); process.stdout.write('\r' + ' '.repeat(text.length + 14) + '\r'); };
}

async function call(messages, { code = false, max } = {}) {
  const key = keyOf();
  if (!key) throw new Error(NOT_SIGNED_IN());
  const stop = spinner(code ? 'Writing the code' : 'Thinking');
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': `codeconclave-cli/${VERSION}` },
      body: JSON.stringify({ model: code ? 'codeconclave-code' : 'codeconclave-1', messages, ...(max ? { max_tokens: max } : {}) }), signal: AbortSignal.timeout(300000) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error(NOT_VALID);
    if (!r.ok) throw new Error(d?.error?.message || d?.error || `CodeConClave answered ${r.status}.`);
    return String(d?.choices?.[0]?.message?.content || '').trim();
  } finally { stop(); }
}

// the code inside the answer: the biggest fenced block, else the whole answer
function codeOf(text) {
  const blocks = [...text.matchAll(/```[\w.+-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return { code: (blocks.length ? blocks.sort((a, b) => b.length - a.length)[0] : text).replace(/\s+$/, '') + '\n', fenced: blocks.length > 0 };
}
// an answer with no code block may be words, not a file: show it and ask first
async function fileOk(got) {
  if (got.fenced) return true;
  console.log(dim(got.code.slice(0, 600)));
  return yes('This answer has no code block. Write it to the file anyway?');
}

// a line diff (longest common subsequence) - shows what will change before anything is written
function diff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  if (A.length * B.length > 9e6) return { add: B.length, del: A.length, text: dim('(too big to show line by line)') };
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) { ops.push(['+', B[j]]); j++; }
    else { ops.push(['-', A[i]]); i++; }
  }
  const near = ops.map((o, k) => o[0] !== ' ' || ops.slice(Math.max(0, k - 2), k + 3).some((x) => x[0] !== ' '));
  const out = []; let skipped = false;
  ops.forEach(([t, s], k) => { if (!near[k]) { if (!skipped) out.push(dim('  ...')); skipped = true; return; } skipped = false; out.push(t === '+' ? green('+ ' + s) : t === '-' ? red('- ' + s) : dim('  ' + s)); });
  return { add: ops.filter((o) => o[0] === '+').length, del: ops.filter((o) => o[0] === '-').length, text: out.slice(0, 400).join('\n') + (out.length > 400 ? '\n' + dim('  ... more') : '') };
}

function readCode(file) {
  const p = resolve(file);
  if (!existsSync(p)) throw new Error(`I can't find ${file}.`);
  const t = readFileSync(p, 'utf8');
  if (t.length > MAX_FILE) throw new Error(`${file} is too big (${Math.round(t.length / 1000)} KB). The CLI sends files up to ${MAX_FILE / 1000} KB.`);
  return t;
}

async function make(file, what) {
  if (!file || !what) throw new Error('Use: make <file> "what to build"');
  const got = codeOf(await call([{ role: 'system', content: `You write one complete, working file named ${basename(file)}. Reply with the whole file in one code block and nothing else. No placeholders, no "rest of the code here".` }, { role: 'user', content: what }], { code: true }));
  if (!(await fileOk(got))) return console.log('Nothing was changed.');
  const out = got.code;
  const p = resolve(file);
  if (existsSync(p) && !(await yes(`${file} already exists. Replace it? A copy is kept as ${basename(file)}.bak`))) return console.log('Nothing was changed.');
  if (existsSync(p)) copyFileSync(p, p + '.bak');
  mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, out);
  console.log(green(`✓ Wrote ${file}`) + dim(` (${out.split('\n').length} lines)`));
  if (/\.html?$/i.test(file)) console.log(dim('  Open it in your browser to try it.'));
}

async function edit(file, what) {
  if (!file || !what) throw new Error('Use: edit <file> "what to change"');
  const before = readCode(file);
  const got = codeOf(await call([{ role: 'system', content: `You change a file. Reply with the WHOLE new file ${basename(file)} in one code block and nothing else. Keep everything that was not asked to change exactly as it was.` }, { role: 'user', content: `What to change: ${what}\n\nThe file ${basename(file)} now:\n\`\`\`\n${before}\n\`\`\`` }], { code: true }));
  if (!(await fileOk(got))) return console.log('Nothing was changed.');
  const after = got.code;
  if (after.trim() === before.trim()) return console.log('No change was needed.');
  const d = diff(before.replace(/\n$/, ''), after.replace(/\n$/, ''));
  console.log(d.text + '\n' + bold(`${file}: `) + green(`+${d.add}`) + ' ' + red(`-${d.del}`));
  if (!(await yes('Write this change?'))) return console.log('Nothing was changed.');
  copyFileSync(resolve(file), resolve(file) + '.bak'); writeFileSync(resolve(file), after);
  console.log(green(`✓ Changed ${file}`) + dim(`  (the old one is ${basename(file)}.bak)`));
}

async function stdinText() {
  if (process.stdin.isTTY) return '';
  let s = ''; for await (const ch of process.stdin) { s += ch; if (s.length > MAX_FILE) break; }
  return s.slice(0, MAX_FILE);
}

// ---- the coding agent in this folder (the same plan -> steps protocol as the app; the files never leave your computer except
// the ones it reads to do the task) ----
const SKIP = /(^|\/)(node_modules|\.git|dist|build|\.next|__pycache__|\.venv|venv|coverage|target|out|\.codeconclave\/checkpoints)(\/|$)/;
function listFiles(dir = process.cwd(), base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (out.length >= 500) break;
    const p = join(dir, n), rel = p.slice(base.length + 1).split('\\').join('/');
    if (SKIP.test(rel) || /^\.env/.test(n)) continue;
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) listFiles(p, base, out); else out.push(rel);
  }
  return out;
}
const RULE_FILES = ['CODECONCLAVE.md', 'codeconclave.md', 'AGENTS.md'];
function projectRules() { const p = RULE_FILES.map((n) => join(process.cwd(), n)).find((x) => existsSync(x)); try { return p ? readFileSync(p, 'utf8').slice(0, 4000) : ''; } catch { return ''; } }
const lineTag = (t) => { let h = 2166136261; t = String(t).replace(/\s+$/, ''); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 1296).toString(36).padStart(2, '0'); };
const numbered = (t) => String(t).split('\n').map((l, i) => `${i + 1}:${lineTag(l)}| ${l}`).join('\n');
const tagOk = (lines, n, tag) => !tag || (n >= 1 && n <= lines.length && lineTag(lines[n - 1]) === String(tag).toLowerCase());
function applyOp(before, a) {
  const lines = String(before).split('\n'), add = String(a.text ?? '').replace(/^\s*\d+(?::[0-9a-z]{2})?\| ?/gm, '').split('\n');
  if (a.tool === 'insert') { const n = Math.max(0, Math.min(lines.length, Math.floor(Number(a.after)) || 0)); if (n && !tagOk(lines, n, a.afterTag)) return { stale: n }; lines.splice(n, 0, ...add); return lines.join('\n'); }
  if (a.tool === 'replace') { const f2 = Math.floor(Number(a.from)), t = Math.floor(Number(a.to)); if (!(f2 >= 1 && t >= f2 && t <= lines.length)) return null; if (!tagOk(lines, f2, a.fromTag)) return { stale: f2 }; if (!tagOk(lines, t, a.toTag)) return { stale: t }; lines.splice(f2 - 1, t - f2 + 1, ...add); return lines.join('\n'); }
  if (a.tool === 'edit') return a.find && before.includes(a.find) ? before.replace(a.find, () => String(a.replace ?? '')) : null;
  return null;
}
const inside = (rel) => { const p = resolve(process.cwd(), rel); return p.startsWith(process.cwd() + sep) ? p : null; };
const CP_DIR = () => join(process.cwd(), '.codeconclave', 'checkpoints');
const JUST_DO = /\b(just do it|no plan|skip the plan|without a plan|quick fix)\b/i;
async function doTask(goal, { auto = false } = {}) {
  goal = String(goal || '').trim(); if (!goal) throw new Error('Say what to do: do "add a dark mode button"');
  const files = listFiles(), rules = projectRules(), folder = basename(process.cwd());
  if (rules) console.log(dim('Following the rules in this folder\'s CODECONCLAVE.md / AGENTS.md.'));
  let plan = [];
  if (!JUST_DO.test(goal)) {
    const stop = spinner('Making a plan'); let d; try { d = await api('POST', '/v1/agent/plan', { goal, files, folder, rules }); } finally { stop(); }
    plan = d.plan.steps;
    const paint = () => { console.log(bold('Plan')); plan.forEach((p, i) => console.log(`  ${dim(String(i + 1) + '.')} ${p}`)); if (d.plan.files?.length) console.log(dim('  Files: ' + d.plan.files.join(', '))); if (d.plan.note) console.log(yellow('  ' + d.plan.note)); };
    paint();
    for (;;) {
      const a = (await ask(`Start? ${dim('(y = yes, e = edit the plan, n = no) ')}`)).trim().toLowerCase();
      if (/^y/.test(a)) break;
      if (/^n/.test(a) || !a) return console.log('Nothing was changed.');
      if (/^e/.test(a)) { console.log(dim('Type the plan, one step per line. An empty line finishes it.')); const lines = []; for (;;) { const l = (await ask('  ')).trim(); if (!l) break; lines.push(l.slice(0, 160)); if (lines.length >= 8) break; } if (lines.length) plan = lines; paint(); }
    }
  }
  const runId = new Date().toISOString().replace(/[:.]/g, '-'), changes = [], hist = []; let now = 0, summary = '', err = '', all = auto;
  const tick = (n) => { if (!plan.length || !n || n === now) return; now = n; console.log(yellow(`▸ Step ${n}/${plan.length}: ${plan[n - 1]}`)); };
  const saveCp = () => { mkdirSync(CP_DIR(), { recursive: true }); writeFileSync(join(CP_DIR(), runId + '.json'), JSON.stringify({ goal, at: Date.now(), changes }, null, 1)); };
  for (let step = 0; step < 20; step++) {
    const stop = spinner(plan.length && now ? `Step ${now}/${plan.length}` : 'Working'); let d;
    try { d = await api('POST', '/v1/agent/step', { goal, files, history: hist, desktop: true, folder, rules, ...(plan.length ? { plan } : {}) }); } catch (e) { stop(); err = e.message; break; }
    stop();
    const a = d.action; hist.push({ role: 'assistant', content: JSON.stringify(a) }); tick(a.step);
    if (a.tool === 'done') { summary = String(a.summary || '').trim(); break; }
    const sig = JSON.stringify(a); if (hist.filter((h) => h.role === 'assistant' && h.content === sig).length >= 3) { err = 'It kept trying the same step, so it stopped.'; break; }
    let result = '';
    const p = a.path ? inside(String(a.path).replace(/^\.?\//, '')) : null, rel = p ? p.slice(process.cwd().length + 1).split('\\').join('/') : '';
    if (a.tool === 'read') { if (!p) result = 'ERROR: that path is outside the folder.'; else { try { result = numbered(readFileSync(p, 'utf8').slice(0, 20000)); console.log(dim('  read ' + rel)); } catch { result = 'ERROR: there is no file ' + a.path; } } }
    else if (['edit', 'insert', 'replace', 'write'].includes(a.tool)) {
      if (!p) result = 'ERROR: that path is outside the folder.';
      else {
        const before = existsSync(p) ? readFileSync(p, 'utf8') : null;
        const next = a.tool === 'write' ? String(a.content ?? '') : before === null ? null : applyOp(before, a);
        if (next === null) result = before === null ? `ERROR: ${rel} does not exist - use write to create it.` : `ERROR: that change does not fit ${rel} - read it again and use its line numbers.`;
        else if (typeof next === 'object') result = `ERROR: line ${next.stale} of ${rel} is not what you read (its fingerprint changed), so nothing was changed. Read ${rel} again.`;
        else if (changes.length >= 12 && !changes.some((x) => x.path === rel)) result = 'ERROR: too many files changed - finish with done.';
        else {
          const newLines = next.replace(/\n$/, '').split('\n');
          const dd = before === null ? { add: newLines.length, del: 0, text: newLines.slice(0, 60).map((l) => green('+ ' + l)).join('\n') + (newLines.length > 60 ? '\n' + dim('  ... more') : '') } : diff(before.replace(/\n$/, ''), next.replace(/\n$/, ''));
          console.log(bold(`${before === null ? 'Create' : 'Change'} ${rel}`) + ' ' + green(`+${dd.add}`) + ' ' + red(`-${dd.del}`)); console.log(dd.text);
          let ok = all;
          if (!ok) { const ans = (await ask(`Apply it? ${dim('(y = yes, a = yes to all, n = no) ')}`)).trim().toLowerCase(); if (/^a/.test(ans)) all = ok = true; else ok = /^y/.test(ans); }
          if (!ok) result = `The user said no to this change of ${rel}. Do something else or finish with done.`;
          else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, next); changes.push({ n: changes.length + 1, step: a.step || 0, path: rel, before, after: next }); saveCp(); if (before === null) files.push(rel);
            console.log(green(`  ✓ saved ${rel}`) + dim(`  (rewind point ${changes.length})`)); result = a.tool === 'write' ? `OK - saved ${rel}.` : `OK - saved. ${rel} now:\n${numbered(next.slice(0, 20000))}`; }
        }
      }
    }
    else if (a.tool === 'run') {
      const cmd = String(a.command || '').trim();
      console.log(bold('Run: ') + cmd);
      if (!cmd || !(await yes('Run this command?'))) result = 'The user said no to running this command.';
      else { const r = spawnSync(cmd, { shell: true, cwd: process.cwd(), encoding: 'utf8', timeout: 180000, maxBuffer: 4e6 }); const out = (String(r.stdout || '') + String(r.stderr || '')).slice(-5000); console.log(dim(out.slice(-1500))); result = `Exit code ${r.status ?? -1}\n${out}`; }
    }
    else result = 'ERROR: unknown action.';
    hist.push({ role: 'user', content: `Result of ${a.tool}:\n${result}` });
  }
  if (plan.length && summary) console.log(green(`✓ All ${plan.length} steps done`));
  console.log('\n' + (summary || err || 'Nothing was changed.'));
  if (changes.length) console.log(dim(`\n${changes.length} change${changes.length === 1 ? '' : 's'}. To go back: node ${basename(process.argv[1])} rewind`));
}
// go back to before change N of the last run (newest first); a file you edited since is only overwritten after you say yes
async function rewind(nArg) {
  if (!existsSync(CP_DIR())) return console.log('No rewind points in this folder yet.');
  const last = readdirSync(CP_DIR()).filter((x) => x.endsWith('.json')).sort().pop(); if (!last) return console.log('No rewind points in this folder yet.');
  const run = JSON.parse(readFileSync(join(CP_DIR(), last), 'utf8')), live = run.changes.filter((x) => !x.rewound);
  console.log(bold(`Last task: ${run.goal}`));
  run.changes.forEach((x) => console.log(`  ${x.n}. ${x.before === null ? 'created' : 'changed'} ${x.path}${x.step ? dim(' (plan step ' + x.step + ')') : ''}${x.rewound ? dim('  rewound') : ''}`));
  const n = Math.floor(Number(nArg)) || (live.length ? live[0].n : 0); if (!n) return;
  const undo = run.changes.filter((x) => x.n >= n && !x.rewound).reverse(); if (!undo.length) return console.log('Nothing to rewind there.');
  if (!(await yes(`Rewind ${undo.length} change${undo.length === 1 ? '' : 's'} (back to before change ${n})?`))) return console.log('Nothing was changed.');
  for (const x of undo) {
    const p = inside(x.path); if (!p) continue; const cur = existsSync(p) ? readFileSync(p, 'utf8') : null;
    if (cur !== null && cur !== x.after && !(await yes(`${x.path} was changed after the agent saved it. Overwrite your newer work?`))) continue;
    if (x.before === null) { if (existsSync(p)) unlinkSync(p); } else writeFileSync(p, x.before);
    x.rewound = true; console.log(green(`  ↩ ${x.path}`));
  }
  writeFileSync(join(CP_DIR(), last), JSON.stringify(run, null, 1));
}
// saved commands: .codeconclave/commands/<name>.md - the file is the instructions, $ARGUMENTS is replaced by what you type after the name
const CMD_DIR = () => join(process.cwd(), '.codeconclave', 'commands');
function savedCommands() { try { return readdirSync(CMD_DIR()).filter((x) => /^[a-z0-9][\w-]{0,40}\.md$/i.test(x)).map((x) => x.slice(0, -3).toLowerCase()); } catch { return []; } }
function commandGoal(name, args) {
  const file = readdirSync(CMD_DIR()).find((x) => x.toLowerCase() === `${name.toLowerCase()}.md`); if (!file) return '';
  const body = readFileSync(join(CMD_DIR(), file), 'utf8').slice(0, 6000), a = String(args || '').trim();
  return (body.includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(a) : body + (a ? `\n\n${a}` : '')).trim();
}

async function chat() {
  console.log(`${yellow('CodeConClave')} ${dim('v' + VERSION + ' - type /help, /exit to leave')}`);
  const history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: yellow('› ') });
  rl.prompt();
  for await (const line of rl) {
    const t = line.trim();
    if (!t) { rl.prompt(); continue; }
    if (/^\/(exit|quit)$/.test(t)) break;
    rl.pause();
    try {
      if (t === '/help') console.log(dim('/do what to change (the coding agent, plan first)  ·  /rewind [n]  ·  /commands  ·  /make <file> what to build  ·  /edit <file> what to change  ·  /explain <file>  ·  /clear  ·  /exit'));
      else if (t.startsWith('/do ')) { rl.close(); await doTask(t.slice(4)); return chat(); }
      else if (/^\/rewind\b/.test(t)) { rl.close(); await rewind(t.split(/\s+/)[1]); return chat(); }
      else if (t === '/commands') { const l = savedCommands(); console.log(l.length ? l.map((x) => '/' + x).join('  ') : dim('No saved commands. Add .codeconclave/commands/<name>.md (use $ARGUMENTS where your words go).')); }
      else if (/^\/[a-z0-9][\w-]*/i.test(t) && savedCommands().includes(t.slice(1).split(/\s+/)[0].toLowerCase())) { const [name, ...w] = t.slice(1).split(/\s+/); rl.close(); await doTask(commandGoal(name, w.join(' '))); return chat(); }
      else if (t === '/clear') { history.length = 0; console.log(dim('Started a new chat.')); }
      else if (t.startsWith('/make ')) { const [, f, ...w] = t.split(/\s+/); rl.close(); await make(f, w.join(' ')); return chat(); }
      else if (t.startsWith('/edit ')) { const [, f, ...w] = t.split(/\s+/); rl.close(); await edit(f, w.join(' ')); return chat(); }
      else if (t.startsWith('/explain ')) { const f = t.slice(9).trim(); console.log(await call([{ role: 'user', content: `Explain this file simply, then list any bugs you see.\n\n${f}:\n\`\`\`\n${readCode(f)}\n\`\`\`` }])); }
      else { history.push({ role: 'user', content: t }); const rules = projectRules(); const a = await call([...(rules ? [{ role: 'system', content: `The rules of this project (CODECONCLAVE.md) - follow them:\n${rules}` }] : []), ...history.slice(-20)]); history.push({ role: 'assistant', content: a }); console.log(a); }
    } catch (e) { console.log(red(e.message)); }
    rl.resume(); rl.prompt();
  }
  rl.close();
}

// ---- sign in with the CodeConClave account: a short code OK'd in the browser, then the normal messages of that account ----
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
function openBrowser(url) {
  try {
    const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(c, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* the link is printed anyway */ }
}
async function signIn() {
  const s = await fetch(`${BASE}/api/cli/login/start`, { method: 'POST', headers: { 'user-agent': `codeconclave-cli/${VERSION}` } }).then((r) => r.json()).catch(() => ({}));
  if (!s.device) throw new Error(s.error || 'Could not reach CodeConClave to sign in. Check the internet and try again.');
  console.log(`\nOpen this page, check the code and press Connect:\n  ${bold(s.url)}\n\nYour code: ${yellow(bold(s.code))}\n`);
  openBrowser(s.url);
  const stop = spinner('Waiting for you to press Connect in the browser');
  let done = null;
  try {
    for (const until = Date.now() + (s.expiresIn || 600) * 1000; Date.now() < until && !done;) {
      await wait((s.interval || 3) * 1000);
      const r = await fetch(`${BASE}/api/cli/login/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: s.device }) }).catch(() => null);
      if (!r) continue;   // a network blip: ask again
      const d = await r.json().catch(() => ({}));
      if (d.token) done = d;
      else if (r.status === 404) throw new Error(d.error || 'The sign-in ended. Run login again.');
    }
  } finally { stop(); }
  if (!done) throw new Error('The sign-in took too long. Run login again.');
  writeFileSync(CONF, JSON.stringify({ key: done.token, account: done.email || done.name || '' }), { mode: 0o600 });
  console.log(green(`✓ Signed in as ${done.email || done.name}.`) + dim(` It uses your normal CodeConClave messages. Kept in ${CONF} on this computer only.`));
}
const NOT_SIGNED_IN = () => `Not signed in yet. Run:\n  node ${basename(process.argv[1])} login\n(it signs in with your CodeConClave account and uses your normal messages)`;
const NOT_VALID = 'Your sign-in or API key is not valid any more. Run login again.';

// ---- the agent protocol: the same JSON API the IDE extension and other tools use (/v1/tasks, /v1/actions/<id>/run, ...) ----
async function api(method, path, body) {
  const key = keyOf();
  if (!key) throw new Error(NOT_SIGNED_IN());
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': `codeconclave-cli/${VERSION}` }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300000) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error(NOT_VALID);
  if (!r.ok) throw new Error(d?.error?.message || d?.error || `CodeConClave answered ${r.status}.`);
  return d;
}
const show = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
async function action(id, input = {}) {
  const stop = spinner(`Running ${id}`);
  let d; try { d = await api('POST', `/v1/actions/${encodeURIComponent(id)}/run`, { input }); } finally { stop(); }
  if (d.needs_approval) { console.log(yellow(`⏸ ${id} waits for your approval: task ${d.task.id}`)); console.log(dim(`  Approve: node ${basename(process.argv[1])} task approve ${d.task.id}`)); return null; }
  return d.result;
}
async function watch(id, kind = 'tasks') {
  const key = keyOf();
  const r = await fetch(`${BASE}/v1/${kind}/${encodeURIComponent(id)}/stream`, { headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' } });
  if (!r.ok || !r.body) throw new Error(`Could not follow the task (${r.status}).`);
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = (block.match(/^event: (.+)$/m) || [])[1], data = (block.match(/^data: (.+)$/m) || [])[1];
      if (!type || !data) continue;
      const e = JSON.parse(data);
      if (type === 'end') { console.log(bold(`■ ${e.status}`) + (e.result_status ? dim(` (${e.result_status})`) : '')); return; }
      if (type === 'approval_requested' && kind === 'runs' && tty) {
        // a risky step waits: the yes needs the 6-digit code the app shows you (a program alone can never approve)
        console.log(yellow(`⏸ Step ${(e.step ?? 0) + 1} waits for your yes (${e.data?.risk || 'risky'}). Open CodeConClave -> Command Center -> Needs your yes to see exactly what it does and its code.`));
        const code = (await ask('Type the 6-digit code to approve it, or press Enter to leave it waiting: ')).trim();
        if (/^\d{6}$/.test(code)) { try { await api('POST', `/v1/runs/${encodeURIComponent(id)}/approve`, { code }); console.log(green('✓ Approved.')); } catch (err) { console.log(red(err.message)); } }
        else { console.log(dim(`Left waiting. Later: node ${basename(process.argv[1])} approve ${id} <code>`)); return; }
        continue;
      }
      console.log(`${dim(new Date(e.at).toLocaleTimeString())} ${yellow(type)} ${dim(e.data ? JSON.stringify(e.data).slice(0, 140) : '')}`);
    }
  }
}
// local folder <-> cloud workspace (text files only; node_modules, .git and secrets files are skipped)
function readFolder(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (/^(node_modules|\.git|dist|build|\.next|__pycache__)$/.test(n) || /^\.env/.test(n) || /\.(png|jpe?g|gif|webp|ico|zip|exe|dll|pdf|mp[34]|woff2?)$/i.test(n)) continue;
    const p = join(dir, n), s = statSync(p);
    if (s.isDirectory()) readFolder(p, base, out);
    else if (s.size <= 200000) out.push({ path: p.slice(base.length + 1).split('\\').join('/'), content: readFileSync(p, 'utf8') });
    if (out.length > 300) break;
  }
  return out;
}
async function agent(cmd, rest) {
  const [sub, a1, ...more] = rest, a2 = more.join(' ');
  if (cmd === 'status') { const t = await api('GET', '/v1/tasks'), a = await api('GET', '/v1/actions'); return show({ api: BASE, key: 'valid', tasks: t.tasks.length, working: t.tasks.filter((x) => !/completed|cancelled|failed_permanently/.test(x.status)).length, actions: a.summary }); }
  if (cmd === 'task') {
    if (sub === 'create') { const flag = (n) => { const k = rest.indexOf(`--${n}`); return k > 0 ? rest[k + 1] : undefined; }; const prompt = rest.slice(1).filter((x, k, all) => !x.startsWith('--') && !(k > 0 && all[k - 1].startsWith('--'))).join(' ');
      const d = await api('POST', '/v1/tasks', { task_type: flag('type') || 'answer', prompt, role: flag('role'), mode: flag('mode') }); console.log(green(`✓ Task ${d.task.id}`) + dim(` (${d.task.status})`)); return watch(d.task.id); }
    if (sub === 'list') return (await api('GET', '/v1/tasks')).tasks.forEach((t) => console.log(`${t.id}  ${yellow(t.status.padEnd(24))} ${t.type.padEnd(16)} ${dim(String(t.prompt).slice(0, 60))}`));
    if (sub === 'watch') return watch(a1);
    if (['approve', 'reject', 'cancel', 'pause', 'resume', 'retry'].includes(sub)) { if (sub === 'approve' && !/^\d{6}$/.test(String(more[0] || ''))) throw new Error('Approve needs the 6-digit code shown in the app: task approve <id> <code>'); const d = await api('POST', `/v1/tasks/${encodeURIComponent(a1)}/${sub}`, sub === 'approve' ? { code: more[0] } : {}); return console.log(green(`✓ ${d.task.id}: ${d.task.status}`)); }
    if (sub === 'show') return show((await api('GET', `/v1/tasks/${encodeURIComponent(a1)}`)).task);
  }
  if (cmd === 'logs' && sub === 'follow') return watch(a1);
  // ---- runs: the plan is shown first, risky steps need your yes (with the app's code), the report is checked by code ----
  const me = basename(process.argv[1]);
  const showPlan = (p) => { console.log(bold(`Plan for: ${p.goal}`)); p.steps.forEach((s, k) => console.log(`  ${k + 1}. ${s.title} ${dim(s.action)}${s.approval ? yellow('  asks your yes') : ''}${s.depends_on?.length ? dim(`  (uses ${s.depends_on.join(', ')})`) : ''}`)); if (p.assumptions?.length) console.log(dim(`  Assumes: ${p.assumptions.join('; ')}`)); };
  const showReport = (run) => { const r = run.report; if (!r) return console.log(bold(`■ ${run.status}`)); console.log(bold(`Result (${run.status.replace(/_/g, ' ')})`)); if (r.summary) console.log(`\n${r.summary}\n`); r.verification_checks.forEach((x) => console.log(`  ${x.ok ? green('✓') : red('✕')} ${x.check} ${dim(x.detail)}`)); r.warnings.forEach((w) => console.log(yellow(`  ! ${w}`))); console.log(dim(`  Confidence: ${r.confidence.level} (${r.confidence.reason})${r.rollback_available ? ` · undo: node ${me} undo ${run.id}` : ''}`)); };
  if (cmd === 'plan' || (cmd === 'run' && !['show', 'watch', 'cancel', 'pause', 'resume', 'retry'].includes(sub))) {
    const goal = rest.filter((x) => x !== '--yes').join(' ').trim(); if (!goal) throw new Error(`Say the goal: node ${me} ${cmd} "what should be done"`);
    const stop = spinner('Planning with real tools'); let p; try { p = await api('POST', '/v1/runs/plan', { goal }); } finally { stop(); }
    showPlan(p);
    if (cmd === 'plan') return;
    if (!rest.includes('--yes') && !(await yes('Start this run?'))) return console.log('Nothing was started.');
    const d = await api('POST', '/v1/runs', { goal: p.goal, plan: { steps: p.steps, success_criteria: p.success_criteria, assumptions: p.assumptions }, interface: 'cli' });
    console.log(green(`✓ Run ${d.run.id}`)); await watch(d.run.id, 'runs');
    return showReport((await api('GET', `/v1/runs/${encodeURIComponent(d.run.id)}`)).run);
  }
  if (cmd === 'run') {
    if (sub === 'show') return showReport((await api('GET', `/v1/runs/${encodeURIComponent(a1)}`)).run);
    if (sub === 'watch') { await watch(a1, 'runs'); return showReport((await api('GET', `/v1/runs/${encodeURIComponent(a1)}`)).run); }
    const d = await api('POST', `/v1/runs/${encodeURIComponent(a1)}/${sub}`, {}); return console.log(green(`✓ ${d.run.id}: ${d.run.status}`));
  }
  if (cmd === 'runs') return (await api('GET', '/v1/runs')).runs.forEach((r) => console.log(`${r.id}  ${yellow(r.status.padEnd(24))} ${dim(String(r.goal).slice(0, 70))}`));
  if (cmd === 'approve') { const code = rest[1]; if (!/^\d{6}$/.test(String(code || ''))) throw new Error(`Approve needs the 6-digit code shown in the app: node ${me} approve <run id> <code>`); const d = await api('POST', `/v1/runs/${encodeURIComponent(rest[0])}/approve`, { code }); return console.log(green(`✓ Approved: ${d.run.status}`)); }
  if (cmd === 'deny') { const d = await api('POST', `/v1/runs/${encodeURIComponent(rest[0])}/reject`, { reason: rest.slice(1).join(' ') || 'Refused from the CLI' }); return console.log(green(`✓ ${d.run.status}`)); }
  if (cmd === 'undo') { if (!(await yes(`Undo run ${rest[0]}? A new run of the opposite steps starts (risky ones still ask).`))) return; const d = await api('POST', `/v1/runs/${encodeURIComponent(rest[0])}/rollback`, {}); console.log(green(`✓ Undo run ${d.run.id}`)); (d.cannot_undo || []).forEach((x) => console.log(yellow(`  cannot undo: ${x.title} (${x.why})`))); return watch(d.run.id, 'runs'); }
  if (cmd === 'report') {
    const id = rest[0], out = rest[1]; if (!out) return showReport((await api('GET', `/v1/runs/${encodeURIComponent(id)}`)).run);
    const r = await fetch(`${BASE}/v1/runs/${encodeURIComponent(id)}/report.pdf`, { headers: { authorization: `Bearer ${keyOf()}` } });
    if (!r.ok || !/pdf/.test(r.headers.get('content-type') || '')) throw new Error('The PDF printer is busy right now; try again in a minute (or open the run in the app).');
    writeFileSync(resolve(out), Buffer.from(await r.arrayBuffer())); return console.log(green(`✓ Saved ${out}`));
  }
  if (cmd === 'trace') { const t = (await api('GET', `/v1/runs/${encodeURIComponent(rest[0])}/trace`)).trace; console.log(dim(`trace ${t.traceId}`)); return t.spans.forEach((x) => console.log(`  ${x.parentSpanId ? '  ' : ''}${x.status.code === 2 ? red('✕') : x.status.code === 1 ? green('✓') : dim('·')} ${x.name} ${dim(`${Math.round((Number(x.endTimeUnixNano) - Number(x.startTimeUnixNano)) / 1e6)} ms`)}`)); }
  if (cmd === 'inbox') { const l = (await api('GET', '/v1/inbox')).approvals.filter((a) => !a.expired); if (!l.length) return console.log('Nothing waits for your yes.'); return l.forEach((a) => console.log(`${yellow('⏸')} ${a.task_id}  ${a.action} ${dim(`(${a.risk})`)}\n   ${dim(a.summary)}\n   ${dim(`approve: node ${me} approve ${a.task_id} <code from the app>`)}`)); }
  if (cmd === 'activity') return (await api('GET', '/v1/activity?limit=40')).events.reverse().forEach((e) => console.log(`${dim(new Date(e.at).toLocaleTimeString())} ${yellow(e.type.padEnd(22))} ${dim(`${e.actor || ''} ${e.task_id}`)}`));
  if (cmd === 'actions' && sub === 'search') { const r = await fetch(`${BASE}/api/actions/search?q=${encodeURIComponent(rest.slice(1).join(' '))}&limit=20`).then((x) => x.json()); return r.actions.forEach((x) => console.log(`${x.available ? green('●') : red('○')} ${x.action_id.padEnd(44)} ${x.needs_connection ? yellow(`needs ${x.needs_connection} `) : x.needs_approval ? yellow('asks first ') : ''}${dim(x.name).slice(0, 80)}`)); }
  if (cmd === 'js') { const src = existsSync(rest[0] || '') ? readFileSync(rest[0], 'utf8') : rest.join(' '); const r = await action('run_javascript_sandboxed', { code: src }); if (!r) return; (r.logs || []).forEach((l) => console.log(dim(l))); return show(r.result); }
  if (cmd === 'mcp') { const m = await fetch(`${BASE}/api/mcp`).then((x) => x.json()); console.log(dim('Add this to your MCP client (IDE or AI app) - it uses your API key and can never approve risky steps without your code:')); return show({ mcpServers: { codeconclave: { type: 'http', url: m.url, headers: { Authorization: 'Bearer <your CodeConClave API key>' } } } }); }
  if (cmd === 'action') {
    if (sub === 'list') { const d = await api('GET', `/v1/actions${a1 ? `?category=${encodeURIComponent(a1)}` : ''}`); d.actions.forEach((x) => console.log(`${x.status === 'available' ? green('●') : red('○')} ${x.action_id.padEnd(34)} ${dim(x.category.padEnd(13))} ${x.approval ? yellow('asks first ') : '           '}${dim(x.why || x.description).slice(0, 90)}`)); return console.log(dim(`\n${d.summary.available} of ${d.summary.total} available.`)); }
    if (sub === 'run') { let input = {}; if (more.length) { try { input = JSON.parse(more.join(' ')); } catch { throw new Error('The input must be JSON, like \'{"query":"chai"}\''); } } const r = await action(a1, input); return r && show(r); }
  }
  if (cmd === 'model') {
    if (sub === 'list' || sub === 'health') return show((await action('list_available_models', {}))?.models);
    if (sub === 'route') return show(await api('POST', '/v1/models/route', { mode: a1 || 'best_available' }));
  }
  if (cmd === 'workspace') {
    if (sub === 'create') { const r = await action('create_cloud_workspace', { name: a1 || basename(process.cwd()) }); return r && console.log(green(`✓ Workspace ${r.id}`) + dim(`  push files: node ${basename(process.argv[1])} workspace push ${r.id} .`)); }
    if (sub === 'list') return show((await api('GET', '/v1/workspaces')).workspaces);
    if (sub === 'push') { const files = readFolder(resolve(more[0] || '.')); if (!(await yes(`Upload ${files.length} files to ${a1}?`))) return console.log('Nothing was sent.'); const d = await api('POST', `/v1/workspaces/${encodeURIComponent(a1)}/files`, { files }); return console.log(green(`✓ ${d.written} files uploaded.`)); }
    if (sub === 'pull') {
      const dir = resolve(more[0] || '.'), files = (await api('GET', `/v1/workspaces/${encodeURIComponent(a1)}/files`)).files;
      const changes = Object.entries(files).filter(([p, t]) => { const f = join(dir, p); return !existsSync(f) || readFileSync(f, 'utf8') !== t; });
      if (!changes.length) return console.log('Already the same.');
      changes.forEach(([p]) => console.log(`  ${existsSync(join(dir, p)) ? yellow('changed') : green('new    ')} ${p}`));
      if (!(await yes(`Write these ${changes.length} files? Changed ones keep a .bak copy.`))) return console.log('Nothing was changed.');
      for (const [p, t] of changes) { const f = join(dir, p); if (!f.startsWith(dir)) continue; mkdirSync(dirname(f), { recursive: true }); if (existsSync(f)) copyFileSync(f, `${f}.bak`); writeFileSync(f, t); }
      return console.log(green(`✓ ${changes.length} files written.`));
    }
  }
  if (cmd === 'file') {
    if (sub === 'read') return console.log((await action('read_file', { workspace_id: a1, path: more[0] }))?.content ?? '');
    if (sub === 'diff') { const r = await action('show_diff', { workspace_id: a1, path: more[0] }); return console.log(r?.diff ? r.diff.lines.map((l) => (l[0] === '+' ? green(l) : l[0] === '-' ? red(l) : dim(l))).join('\n') : r?.note || 'No diff.'); }
  }
  if (cmd === 'code') {
    if (sub === 'change') { const r = await action('implement_code_change', { workspace_id: a1, request: a2 }); if (!r) return; console.log(green(`✓ ${r.summary}`)); r.changed.forEach((c2) => console.log(`  ${c2.path} ${green(`+${c2.added ?? '?'}`)} ${red(`-${c2.removed ?? '?'}`)}`)); return console.log(dim(`  Undo all: action run restore_workspace_snapshot '{"workspace_id":"${a1}","snapshot_id":"${r.snapshot}"}'`)); }
    if (sub === 'review') return show((await action('review_code', { workspace_id: a1, path: more[0] }))?.findings);
    if (sub === 'test') return show(await action('run_tests', { workspace_id: a1 }));
    if (sub === 'security') return show((await action('review_security', { workspace_id: a1 }))?.findings);
  }
  if (cmd === 'mission' && sub === 'run') { const r = await action('create_mission', { objective: rest.slice(1).join(' ') }); if (r) { console.log(green(`✓ Mission ${r.mission.id}`) + dim(` with ${r.mission.milestones.length} milestones`)); return watch(r.mission.id); } return; }
  if (cmd === 'automation' && sub === 'create') return show(await action('create_automation', { text: rest.slice(1).join(' ') }));
  if (cmd === 'benchmark') { const d = await api('GET', '/v1/evaluations'); if (sub === 'run') console.log(dim('Benchmarks are run by the owner with the frozen evaluation setup; here are the recorded runs.')); return show(d.runs.length ? d.runs : d.note); }
  if (cmd === 'stop') { if (!(await yes('Stop and cancel ALL your running agents now?'))) return; return show(await api('POST', '/v1/agents/stop', {})); }
  if (cmd === 'start') return show(await api('POST', '/v1/agents/start', {}));
  throw new Error(`Unknown command. Run: node ${basename(process.argv[1])} help`);
}
const AGENT_CMDS = new Set(['status', 'task', 'action', 'model', 'workspace', 'file', 'code', 'mission', 'automation', 'benchmark', 'logs', 'stop', 'start', 'plan', 'run', 'runs', 'approve', 'deny', 'undo', 'report', 'trace', 'inbox', 'activity', 'actions', 'js', 'mcp']);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === '--version' || cmd === '-v') return console.log(VERSION);
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') return console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 25).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  if (AGENT_CMDS.has(cmd)) return agent(cmd, rest);
  if (cmd === 'login' && (rest[0] === '--key' || rest[0] === 'key')) {
    const k = (await ask('Paste your API key (from Settings -> API keys): ')).trim();
    if (!/^(SHA-[\w-]{30,}|cck_\w+_[\w-]{20,})$/.test(k)) throw new Error('That does not look like a CodeConClave API key (it starts with SHA-).');
    writeFileSync(CONF, JSON.stringify({ key: k }), { mode: 0o600 });
    return console.log(green('✓ Saved.') + dim(` It is kept in ${CONF} on this computer only.`));
  }
  if (cmd === 'login') return signIn();
  if (cmd === 'logout') {
    // --everywhere: every terminal signed in with this account is signed out (an API key is not touched: delete it in Settings)
    const k = keyOf();
    if (rest[0] === '--everywhere' && /^cs1\./.test(k)) {
      const r = await fetch(`${BASE}/api/cli/logout`, { method: 'POST', headers: { authorization: `Bearer ${k}` } }).catch(() => null);
      console.log(r?.ok ? 'Every terminal signed in with your account is signed out.' : dim('Could not reach CodeConClave to sign out the other terminals.'));
    }
    writeFileSync(CONF, '{}', { mode: 0o600 }); return console.log('Signed out on this computer.');
  }
  if (cmd === 'do') return doTask(rest.filter((x) => x !== '--yes').join(' '), { auto: rest.includes('--yes') });
  if (cmd === 'rewind') return rewind(rest[0]);
  if (cmd === 'commands') { const l = savedCommands(); return console.log(l.length ? l.join('\n') : 'No saved commands. Add .codeconclave/commands/<name>.md in this folder (use $ARGUMENTS where your words go).'); }
  if (cmd && savedCommands().includes(cmd.toLowerCase())) return doTask(commandGoal(cmd, rest.filter((x) => x !== '--yes').join(' ')), { auto: rest.includes('--yes') });
  if (cmd === 'make') return make(rest[0], rest.slice(1).join(' '));
  if (cmd === 'edit') return edit(rest[0], rest.slice(1).join(' '));
  if (cmd === 'explain') { const f = rest[0]; return console.log(await call([{ role: 'user', content: `Explain this file simply, then list any bugs you see.\n\n${f}:\n\`\`\`\n${readCode(f)}\n\`\`\`` }])); }
  const piped = await stdinText();
  if (!cmd && !piped) return chat();
  const q = [cmd, ...rest].filter(Boolean).join(' ') || 'Explain this.';
  console.log(await call([{ role: 'user', content: piped ? `${q}\n\n\`\`\`\n${piped}\n\`\`\`` : q }], { code: Boolean(piped) }));
}
main().catch((e) => { console.error(red(e.message)); process.exitCode = 1; });
