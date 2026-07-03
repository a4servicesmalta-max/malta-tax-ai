/**
 * Persistence for accounts + generated returns.
 *
 * ponytail: flat JSON files + synchronous read-modify-write on a single Render
 * instance (backed by a persistent disk at /data). Right-sized for pilot →
 * small-firm scale; migrate to Postgres when concurrency or volume grows.
 * Sync writes serialise mutations within Node's single thread, so concurrent
 * requests can't interleave a read-modify-write.
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR =
  process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(process.cwd(), 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const RETURNS_FILE = path.join(DATA_DIR, 'returns.json');

export interface User {
  id: string;
  email: string; // stored lowercase
  passwordHash: string; // scrypt: salt:hash
  firm: string;
  credits: number;
  emailVerified: boolean;
  verifyToken: string | null;
  resetToken: string | null;
  resetExpires: number | null;
  createdAt: string;
}

export interface ReturnRow {
  id: string;
  userId: string;
  clientName: string;
  ya: string;
  taxCharge: number;
  createdAt: string;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file); // atomic replace
}

// ---- users ----
export function getUsers(): User[] {
  return readJson<User[]>(USERS_FILE, []);
}
export function findUserByEmail(email: string): User | undefined {
  const e = email.trim().toLowerCase();
  return getUsers().find((u) => u.email === e);
}
export function findUserById(id: string): User | undefined {
  return getUsers().find((u) => u.id === id);
}
export function findUserByField(field: 'verifyToken' | 'resetToken', token: string): User | undefined {
  return getUsers().find((u) => u[field] === token);
}
export function insertUser(u: User): void {
  const users = getUsers();
  users.push(u);
  writeJson(USERS_FILE, users);
}
export function updateUser(id: string, patch: Partial<User>): User | undefined {
  const users = getUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i < 0) return undefined;
  users[i] = { ...users[i], ...patch };
  writeJson(USERS_FILE, users);
  return users[i];
}

// ---- returns ----
export function getReturns(): ReturnRow[] {
  return readJson<ReturnRow[]>(RETURNS_FILE, []);
}
export function listReturns(userId: string): ReturnRow[] {
  return getReturns()
    .filter((r) => r.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export function findReturn(id: string): ReturnRow | undefined {
  return getReturns().find((r) => r.id === id);
}
export function saveReturn(row: ReturnRow, xlsx: Buffer, summaryHtml: string): void {
  fs.writeFileSync(path.join(FILES_DIR, `${row.id}.xlsx`), xlsx);
  fs.writeFileSync(path.join(FILES_DIR, `${row.id}.html`), summaryHtml);
  const rows = getReturns();
  rows.push(row);
  writeJson(RETURNS_FILE, rows);
}
export function readReturnFile(id: string, ext: 'xlsx' | 'html'): Buffer | null {
  const p = path.join(FILES_DIR, `${id}.${ext}`);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}
