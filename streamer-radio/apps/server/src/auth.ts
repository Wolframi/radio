import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { UserRecord, UserRole } from '@streamer-radio/shared';

const BCRYPT_ROUNDS = 10;
const JWT_EXPIRES_IN = '24h';

// Read signing key from process.env; generate strong ephemeral key if unset in dev.
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

export function verifyEnvAdminPassword(candidate: string): boolean {
  const configured = process.env.ADMIN_PASSWORD?.trim();
  if (!configured) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function signAuthToken(user: Pick<UserRecord, 'id' | 'username' | 'role'>): string {
  const payload: AuthTokenPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
  };
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded !== 'object') return null;
    const { sub, username, role } = decoded as Partial<AuthTokenPayload>;
    if (!sub || !username || (role !== 'admin' && role !== 'streamer')) {
      return null;
    }
    return { sub, username, role };
  } catch {
    return null;
  }
}

export function extractBearerOrQueryToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const url = new URL(req.url);
  const queryToken = url.searchParams.get('token');
  return queryToken?.trim() || null;
}
