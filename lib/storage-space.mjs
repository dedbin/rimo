/**
 * @param {number} freeBytes
 * @param {number} totalBytes
 * @returns {"low" | "critical" | null}
 */
export function storageSpaceHealth(freeBytes, totalBytes) {
  const fraction = totalBytes > 0 ? freeBytes / totalBytes : 0;
  if (freeBytes < 256 * 1024 * 1024 || fraction < 0.02) return "critical";
  if (freeBytes < 2 * 1024 * 1024 * 1024 || fraction <= 0.2) return "low";
  return null;
}
