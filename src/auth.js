'use strict';
/**
 * People and sessions. Two roles: owner (everything) and dispatcher (operations, no analytics/admin).
 * Passwords: scrypt with a per-user salt. Sessions: random 32-byte tokens; only their SHA-256 is stored.
 */
const crypto = require('node:crypto');

const ROLES = ['owner', 'dispatcher'];
const COOKIE = 'tbb_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Checked when the user doesn't exist, so a login takes the same time either way and doesn't reveal who has an account.
let dummyHash = null;
const dummy = () => (dummyHash ||= hashPassword(crypto.randomBytes(16).toString('hex')));

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return "Parol kamida 8 belgidan iborat bo'lishi kerak";
  return null;
}

class Auth {
  constructor({ h, config }) {
    this.h = h;
    this.cfg = config;
    this.attempts = new Map(); // ip, or "pw:<user id>" -> {n, until}
  }

  _checkLock(key, now) {
    const a = this.attempts.get(key);
    if (a && a.until > now) throw httpError(429, "Juda ko'p urinish. 10 daqiqadan keyin qayta urinib ko'ring");
  }

  _countFailure(key, now) {
    const a = this.attempts.get(key);
    const n = (a && a.until <= now && a.n >= 8 ? 0 : a?.n || 0) + 1;
    this.attempts.set(key, { n, until: n >= 8 ? now + 10 * 60e3 : 0 });
  }

  /** The current password, before changing it. Throttled: a stolen session must not allow unlimited guesses. */
  checkPassword(userId, password) {
    const key = `pw:${userId}`;
    const now = Date.now();
    this._checkLock(key, now);
    const u = this.h.get('SELECT pass_hash FROM users WHERE id = ?', userId);
    if (!u || !verifyPassword(password || '', u.pass_hash)) {
      this._countFailure(key, now);
      throw httpError(400, "Joriy parol noto'g'ri");
    }
    this.attempts.delete(key);
  }

  ensureOwner(log = console) {
    const n = this.h.get('SELECT COUNT(*) n FROM users').n;
    if (n) return;
    const { username, password } = this.cfg.owner;
    if (!username || !password) {
      log.warn?.('No users yet: set OWNER_USERNAME and OWNER_PASSWORD (or run `npm run user -- add ...`) to create the first owner');
      return;
    }
    this.createUser({ username, name: 'Rahbar', role: 'owner', password });
    log.info?.(`Created owner account "${username}"`);
  }

  createUser({ username, name, role, password }) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) throw httpError(400, "Login 3-32 belgi: harf, raqam, . _ -");
    if (name !== undefined && name !== null && typeof name !== 'string') throw httpError(400, "Ism noto'g'ri");
    if (!ROLES.includes(role)) throw httpError(400, "Noto'g'ri rol");
    const pwErr = validatePassword(password);
    if (pwErr) throw httpError(400, pwErr);
    if (this.h.get('SELECT 1 FROM users WHERE username = ?', username)) throw httpError(409, 'Bu login band');
    const r = this.h.run('INSERT INTO users (username, name, role, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      username, (name || username).slice(0, 80), role, hashPassword(password), Date.now());
    return this.user(Number(r.lastInsertRowid));
  }

  updateUser(id, { name, role, disabled, password }, actor) {
    const u = this.h.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw httpError(404, 'Foydalanuvchi topilmadi');
    if (role !== undefined && !ROLES.includes(role)) throw httpError(400, "Noto'g'ri rol");
    const demotingOwner = u.role === 'owner' && !u.disabled && ((role && role !== 'owner') || disabled);
    if (demotingOwner && this.h.get("SELECT COUNT(*) n FROM users WHERE role = 'owner' AND disabled = 0").n <= 1) {
      throw httpError(400, "Kamida bitta faol rahbar (owner) qolishi kerak");
    }
    if (actor && actor.id === id && disabled) throw httpError(400, "O'zingizni o'chira olmaysiz");
    // Everything is checked first: a refused request changes nothing.
    if (name !== undefined && typeof name !== 'string') throw httpError(400, "Ism noto'g'ri");
    if (password !== undefined) {
      const err = validatePassword(password);
      if (err) throw httpError(400, err);
    }
    const passHash = password !== undefined ? hashPassword(password) : null;
    this.h.tx(() => {
      if (name !== undefined) this.h.run('UPDATE users SET name = ? WHERE id = ?', name.slice(0, 80), id);
      if (role !== undefined) this.h.run('UPDATE users SET role = ? WHERE id = ?', role, id);
      if (disabled !== undefined) {
        this.h.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id);
        if (disabled) this.h.run('DELETE FROM sessions WHERE user_id = ?', id);
      }
      if (passHash) {
        this.h.run('UPDATE users SET pass_hash = ? WHERE id = ?', passHash, id);
        this.h.run('DELETE FROM sessions WHERE user_id = ?', id);
      }
    });
    return this.user(id);
  }

  deleteUser(id, actor) {
    if (actor.id === id) throw httpError(400, "O'zingizni o'chira olmaysiz");
    const u = this.h.get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw httpError(404, 'Foydalanuvchi topilmadi');
    if (u.role === 'owner' && !u.disabled && this.h.get("SELECT COUNT(*) n FROM users WHERE role = 'owner' AND disabled = 0").n <= 1) {
      throw httpError(400, "Kamida bitta faol rahbar (owner) qolishi kerak");
    }
    this.h.run('DELETE FROM users WHERE id = ?', id);
  }

  user(id) {
    const u = this.h.get('SELECT id, username, name, role, disabled, created_at, last_login_at FROM users WHERE id = ?', id);
    return u ? { id: u.id, username: u.username, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.created_at, lastLoginAt: u.last_login_at } : null;
  }

  users() {
    return this.h.all('SELECT id FROM users ORDER BY role, username').map((r) => this.user(r.id));
  }

  /** Throttle: 8 failures per IP -> locked for 10 minutes. */
  login(username, password, { ip, ua }) {
    const now = Date.now();
    this._checkLock(ip, now);
    const u = this.h.get('SELECT * FROM users WHERE username = ?', String(username || ''));
    const matches = verifyPassword(password || '', u ? u.pass_hash : dummy()); // always hash: same time for unknown users
    if (!u || u.disabled || !matches) {
      this._countFailure(ip, now);
      throw httpError(401, "Login yoki parol noto'g'ri");
    }
    this.attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = now + this.cfg.sessionDays * 86400e3;
    this.h.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ua, ip) VALUES (?, ?, ?, ?, ?, ?)',
      sha256(token), u.id, now, expires, String(ua || '').slice(0, 200), ip);
    this.h.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, u.id);
    this.h.run('DELETE FROM sessions WHERE expires_at < ?', now);
    return { token, expires, user: this.user(u.id) };
  }

  logout(token) {
    if (token) this.h.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  }

  session(token) {
    if (!token) return null;
    const s = this.h.get(`SELECT s.user_id, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.disabled = 0`, sha256(token));
    if (!s || s.expires_at < Date.now()) return null;
    return this.user(s.user_id);
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { Auth, ROLES, COOKIE, hashPassword, verifyPassword, httpError };
