import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  makeSession,
  sessionUserId,
  loginUser,
  resetPassword,
  consumeCredit,
} from '../src/accounts';
import { insertUser, updateUser, findUserById, type User } from '../src/store';

function seed(over: Partial<User> = {}): User {
  const u: User = {
    id: crypto.randomUUID(),
    email: `u-${crypto.randomUUID()}@test.co`,
    passwordHash: hashPassword('password123'),
    firm: 'Test Firm',
    credits: 3,
    emailVerified: true,
    verifyToken: null,
    resetToken: null,
    resetExpires: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
  insertUser(u);
  return u;
}

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', () => {
    const h = hashPassword('correct horse');
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('session tokens', () => {
  it('accepts a fresh token and rejects expired/tampered ones', () => {
    const token = makeSession('user-123');
    expect(sessionUserId(token)).toBe('user-123');
    expect(sessionUserId(undefined)).toBeNull();
    expect(sessionUserId('user-123.' + (Date.now() - 1000) + '.deadbeef')).toBeNull(); // expired
    expect(sessionUserId('user-123.' + (Date.now() + 60000) + '.deadbeef')).toBeNull(); // bad mac
  });
});

describe('loginUser', () => {
  it('succeeds for a verified user, and reports verify/invalid states', () => {
    const u = seed();
    const ok = loginUser(u.email, 'password123');
    expect(ok.ok).toBe(true);
    expect(sessionUserId(ok.token)).toBe(u.id);

    expect(loginUser(u.email, 'nope').ok).toBe(false);
    expect(loginUser('nobody@test.co', 'x').ok).toBe(false);

    const unverified = seed({ emailVerified: false });
    const r = loginUser(unverified.email, 'password123');
    expect(r.ok).toBe(false);
    expect(r.needsVerify).toBe(true);
  });
});

describe('resetPassword', () => {
  it('resets with a valid token and rejects expired/short', () => {
    const u = seed({ resetToken: 'tok-123', resetExpires: Date.now() + 60000 });
    expect(resetPassword('tok-123', 'short').ok).toBe(false); // < 8 chars
    expect(resetPassword('tok-123', 'newpassword').ok).toBe(true);
    expect(verifyPassword('newpassword', findUserById(u.id)!.passwordHash)).toBe(true);

    const u2 = seed({ resetToken: 'expired', resetExpires: Date.now() - 1000 });
    expect(resetPassword('expired', 'newpassword2').ok).toBe(false);
    expect(u2).toBeTruthy();
  });
});

describe('consumeCredit', () => {
  it('decrements down to zero then refuses', () => {
    const u = seed({ credits: 2 });
    expect(consumeCredit(u.id)).toBe(true);
    expect(consumeCredit(u.id)).toBe(true);
    expect(consumeCredit(u.id)).toBe(false); // none left
    expect(findUserById(u.id)!.credits).toBe(0);
    updateUser(u.id, { credits: 0 });
  });
});
