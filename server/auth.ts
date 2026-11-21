import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import type { UserRecord, UserRole } from '../shared/schemas';

const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES_IN = '24h';

// Ephemeral strong fallback key in memory when JWT_SECRET is not set in environment.
const JWT_SECRET: string =
  process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 16
    ? process.env.JWT_SECRET.trim()
    : crypto.randomBytes(32).toString('hex');

export interface AuthTokenPayload {
  sub: string;
  username: string;
  role: UserRole;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function hasEnvAdminPassword(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim().length > 0);
}

export function verifyEnvAdminPassword(candidate: string): boolean {
  const configured = process.env.ADMIN_PASSWORD?.trim();
  if (!configured) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function signAuthToken(user: Pick<UserRecord, 'id' | 'username' | 'role'>): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
    } satisfies AuthTokenPayload,
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: JWT_EXPIRES_IN },
  );
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded !== 'object') return null;
    const { sub, username, role } = decoded as Partial<AuthTokenPayload>;
    if (!sub || !username || (role !== 'admin' && role !== 'streamer')) return null;
    return { sub, username, role };
  } catch {
    return null;
  }
}

export function extractRequestToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const qToken = req.query.token;
  if (typeof qToken === 'string' && qToken.trim()) {
    return qToken.trim();
  }
  return null;
}
