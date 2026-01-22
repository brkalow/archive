/**
 * Email utilities for session sharing.
 */

/**
 * Normalize an email address for storage and comparison.
 * - Converts to lowercase
 * - Trims whitespace
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Validate email format using basic RFC 5322 regex.
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
