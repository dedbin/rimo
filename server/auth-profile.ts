import { APIError } from "better-auth/api";

import { safeAvatarSrc } from "../lib/safe-avatar";

export function validatedProfile(input: { name?: unknown; image?: unknown }): {
  name?: string;
  image?: string | null;
} {
  const result: { name?: string; image?: string | null } = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || !input.name.trim() ||
        input.name.trim().length > 80 || /[\u0000-\u001f]/.test(input.name)) {
      throw new APIError("BAD_REQUEST", { message: "Имя должно содержать от 1 до 80 символов." });
    }
    result.name = input.name.trim();
  }
  if (input.image !== undefined) {
    if (input.image === null || input.image === "") {
      result.image = null;
      return result;
    }
    const image = safeAvatarSrc(input.image);
    if (!image) {
      throw new APIError("BAD_REQUEST", { message: "Некорректный адрес изображения профиля." });
    }
    result.image = image;
  }
  return result;
}
