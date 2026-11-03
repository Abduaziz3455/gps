'use strict';
/**
 * Manage accounts from the server's shell (e.g. the first owner, or a forgotten password).
 *
 *   npm run user -- list
 *   npm run user -- add <username> <owner|dispatcher> "<Full name>"      (asks for the password)
 *   npm run user -- password <username>                                  (asks for the new password)
 *   npm run user -- disable <username> | enable <username>
 *
 * In Docker:  docker compose exec app npm run user -- add ali dispatcher "Ali Valiyev"
 */
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const config = require('../src/config');
const { open, helpers } = require('../src/db');
const { Auth } = require('../src/auth');

function ask(question, hidden = true) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (!s.includes(question)) return; rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const [cmd, username, role, ...nameParts] = process.argv.slice(2);
  const h = helpers(open(path.join(config.dataDir, 'dispatcher.db')));
  const auth = new Auth({ h, config });
  const byName = () => {
    const u = h.get('SELECT id FROM users WHERE username = ?', username || '');
    if (!u) throw new Error(`No user "${username}"`);
    return u.id;
  };
  switch (cmd) {
    case 'list':
      for (const u of auth.users()) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(11)} ${u.disabled ? 'DISABLED' : 'active  '} ${u.name}`);
      break;
    case 'add': {
      const pw = process.env.NEW_PASSWORD || await ask('Password (8+ chars): ');
      const u = auth.createUser({ username, role, name: nameParts.join(' ') || username, password: pw });
      console.log(`Created ${u.username} (${u.role})`);
      break;
    }
    case 'password': {
      const pw = process.env.NEW_PASSWORD || await ask('New password (8+ chars): ');
      auth.updateUser(byName(), { password: pw });
      console.log('Password changed; existing sessions were signed out');
      break;
    }
    case 'disable':
    case 'enable':
      auth.updateUser(byName(), { disabled: cmd === 'disable' });
      console.log(`${username}: ${cmd}d`);
      break;
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^'use strict';\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
