/**
 * Clerk user lookup utilities for session sharing.
 */

import { createClerkClient } from '@clerk/backend';

// Only create client if Clerk is configured
const clerkClient = process.env.CLERK_SECRET_KEY
  ? createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY,
      publishableKey: process.env.PUBLIC_CLERK_PUBLISHABLE_KEY,
    })
  : null;

// Simple in-memory cache for user lookups
const userCache = new Map<string, { data: ClerkUserInfo; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface ClerkUserInfo {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}

/**
 * Get user info from Clerk with caching.
 */
export async function getUserInfo(userId: string): Promise<ClerkUserInfo | null> {
  if (!clerkClient) {
    return null;
  }

  // Check cache
  const cached = userCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  try {
    const user = await clerkClient.users.getUser(userId);
    const info: ClerkUserInfo = {
      id: user.id,
      email: user.primaryEmailAddress?.emailAddress ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    };

    userCache.set(userId, { data: info, expires: Date.now() + CACHE_TTL });
    return info;
  } catch {
    return null;
  }
}

/**
 * Get the primary email for a user.
 */
export async function getUserEmail(userId: string): Promise<string | null> {
  const info = await getUserInfo(userId);
  return info?.email ?? null;
}

/**
 * Get basic display info for a user (name, email, image).
 */
export async function getUserDisplayInfo(userId: string): Promise<{
  name: string | null;
  email: string | null;
  imageUrl: string | null;
} | null> {
  const info = await getUserInfo(userId);
  if (!info) return null;

  const name = [info.firstName, info.lastName].filter(Boolean).join(' ') || null;
  return {
    name,
    email: info.email,
    imageUrl: info.imageUrl,
  };
}
