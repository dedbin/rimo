const BUNDLED_AVATAR_PATH = /^\/avatars\/avatar_[0-9]\.svg$/;
const UPLOADED_AVATAR_PATH = /^\/api\/assets\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Only canonical local image routes are accepted, identically on server and client. */
export function safeAvatarSrc(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = BUNDLED_AVATAR_PATH.exec(value) ?? UPLOADED_AVATAR_PATH.exec(value);
  // JavaScript's $ can match before a final newline; require the entire raw value.
  return match?.[0] === value ? value : undefined;
}
