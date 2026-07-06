/**
 * User accounts: signup + email verification, login, password reset, sessions,
 * and free-return credits. Auth is self-contained (scrypt password hashing +
 * an HMAC-signed session cookie) — no third-party auth service. Verification
 * and reset emails go out over the same SMTP as the rest of the app.
 */
import crypto from 'node:crypto';
import {
  findUserByEmail,
  findUserById,
  findUserByField,
  insertUser,
  updateUser,
  type User,
} from './store';
import { sendMail, emailConfigured } from './email';

const FREE_CREDITS = Number(process.env.FREE_RETURNS || 3);
const SESSION_TTL_MS = 12 * 3600 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function secret(): string {
  return process.env.SESSION_SECRET || 'dev-insecure-secret';
}
function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || 'https://tax.vacei.com').replace(/\/$/, '');
}

// ---- password hashing (scrypt) ----
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// ---- session token: userId.exp.hmac(userId.exp) ----
export function makeSession(userId: string): string {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const payload = `${userId}.${exp}`;
  const mac = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return `${payload}.${mac}`;
}
export function sessionUserId(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, mac] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const good = crypto.createHmac('sha256', secret()).update(`${userId}.${exp}`).digest('hex');
  if (good.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(mac))) return null;
  return userId;
}

// ---- flows ----
export interface SignupResult {
  ok: boolean;
  error?: string;
}

export async function registerUser(emailRaw: string, password: string, firm: string): Promise<SignupResult> {
  const email = (emailRaw || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  if (!password || password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  if (findUserByEmail(email)) return { ok: false, error: 'An account with that email already exists.' };
  if (!emailConfigured()) return { ok: false, error: 'Email is not configured — cannot send verification.' };

  const verifyToken = crypto.randomBytes(24).toString('hex');
  const user: User = {
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(password),
    firm: (firm || '').trim().slice(0, 120),
    credits: FREE_CREDITS,
    emailVerified: false,
    verifyToken,
    resetToken: null,
    resetExpires: null,
    createdAt: new Date().toISOString(),
  };
  const link = `${baseUrl()}/verify?token=${verifyToken}`;
  try {
    await sendMail(
      email,
      'Confirm your Malta Tax AI account',
      `Welcome to Malta Tax AI.\n\nConfirm your email to activate your account and your ${FREE_CREDITS} free returns:\n\n${link}\n\nIf you didn't request this, ignore this email.`
    );
  } catch {
    return { ok: false, error: 'Could not send the verification email — please try again.' };
  }
  insertUser(user);
  return { ok: true };
}

export function verifyEmail(token: string): boolean {
  const user = findUserByField('verifyToken', token);
  if (!user) return false;
  updateUser(user.id, { emailVerified: true, verifyToken: null });
  return true;
}

export interface LoginResult {
  ok: boolean;
  token?: string;
  error?: string;
  needsVerify?: boolean;
}

export function loginUser(emailRaw: string, password: string): LoginResult {
  const email = (emailRaw || '').trim().toLowerCase();
  const user = findUserByEmail(email);
  // Uniform failure message — never reveal whether the email exists.
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return { ok: false, error: 'Invalid email or password.' };
  }
  if (!user.emailVerified) {
    return { ok: false, needsVerify: true, error: 'Please confirm your email first — check your inbox for the link.' };
  }
  return { ok: true, token: makeSession(user.id) };
}

export async function requestReset(emailRaw: string): Promise<void> {
  const user = findUserByEmail((emailRaw || '').trim().toLowerCase());
  if (!user) return; // silent — no account enumeration
  const resetToken = crypto.randomBytes(24).toString('hex');
  updateUser(user.id, { resetToken, resetExpires: Date.now() + RESET_TTL_MS });
  const link = `${baseUrl()}/reset?token=${resetToken}`;
  try {
    await sendMail(
      user.email,
      'Reset your Malta Tax AI password',
      `Reset your password using this link (valid for 1 hour):\n\n${link}\n\nIf you didn't request this, ignore this email.`
    );
  } catch {
    // swallow — don't reveal delivery state
  }
}

export function resetPassword(token: string, password: string): { ok: boolean; error?: string } {
  if (!password || password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  const user = findUserByField('resetToken', token);
  if (!user || !user.resetExpires || user.resetExpires < Date.now()) {
    return { ok: false, error: 'This reset link is invalid or has expired.' };
  }
  updateUser(user.id, { passwordHash: hashPassword(password), resetToken: null, resetExpires: null });
  return { ok: true };
}

export function currentUser(token: string | undefined): User | null {
  const id = sessionUserId(token);
  return id ? findUserById(id) ?? null : null;
}

/**
 * Create a pre-verified admin account from ADMIN_EMAIL/ADMIN_PASSWORD if it
 * doesn't exist. Idempotent. Gives the firm a guaranteed login without waiting
 * on email verification. No-op when the env vars are unset.
 */
export function bootstrapAdmin(): void {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password || findUserByEmail(email)) return;
  insertUser({
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(password),
    firm: 'A4 / VACEI',
    credits: Number(process.env.ADMIN_CREDITS || 9999),
    emailVerified: true,
    verifyToken: null,
    resetToken: null,
    resetExpires: null,
    createdAt: new Date().toISOString(),
  });
  // eslint-disable-next-line no-console
  console.info(`[accounts] bootstrapped admin ${email}`);
}

/**
 * Grant credits to a user by email — the manual sales flow (bank transfer →
 * admin grants). Caller must be the ADMIN_EMAIL account. Returns the new
 * balance or null (unknown target / not admin / bad amount).
 */
export function grantCredits(adminEmail: string, targetEmail: string, credits: number): number | null {
  const admin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!admin || adminEmail.toLowerCase() !== admin) return null;
  if (!Number.isFinite(credits) || credits <= 0 || credits > 1000) return null;
  const user = findUserByEmail(targetEmail.trim().toLowerCase());
  if (!user) return null;
  const updated = updateUser(user.id, { credits: user.credits + Math.floor(credits) });
  return updated ? updated.credits : null;
}

/** Atomically decrement a credit; returns false if none left. */
export function consumeCredit(userId: string): boolean {
  const user = findUserById(userId);
  if (!user || user.credits < 1) return false;
  updateUser(userId, { credits: user.credits - 1 });
  return true;
}
