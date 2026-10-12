/**
 * Parse comma-separated ALLOWED_ORIGINS and optionally include FRONTEND_URL.
 */
export function parseAllowedOrigins(
  allowedOriginsEnv?: string | null,
  frontendUrl?: string | null,
): string[] {
  const fromList = String(allowedOriginsEnv ?? '')
    .split(',')
    .map((value) => normalizeOrigin(value))
    .filter((value): value is string => Boolean(value));

  const fromFrontend = normalizeOrigin(frontendUrl);
  const merged = fromFrontend ? [...fromList, fromFrontend] : fromList;
  return [...new Set(merged)];
}

/** Normalize a URL or origin string to `scheme://host[:port]`, or null if invalid. */
export function normalizeOrigin(value?: string | null): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    return null;
  }
}

export function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    return false;
  }
  return allowedOrigins.includes(normalized);
}

/** Prefer Origin; fall back to Referer's origin for same-site navigations. */
export function resolveRequestOrigin(
  originHeader?: string | string[] | null,
  refererHeader?: string | string[] | null,
): string | null {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  const fromOrigin = normalizeOrigin(origin);
  if (fromOrigin) {
    return fromOrigin;
  }

  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
  return normalizeOrigin(referer);
}
