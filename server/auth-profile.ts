import { APIError } from "better-auth/api";

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
    if (typeof input.image !== "string" || input.image.length > 2048) {
      throw new APIError("BAD_REQUEST", { message: "Некорректный адрес изображения профиля." });
    }
    let image: URL;
    try {
      image = new URL(input.image);
    } catch {
      throw new APIError("BAD_REQUEST", { message: "Некорректный адрес изображения профиля." });
    }
    if (!["https:", "http:"].includes(image.protocol) || image.username || image.password) {
      throw new APIError("BAD_REQUEST", { message: "Некорректный адрес изображения профиля." });
    }
    result.image = image.toString();
  }
  return result;
}
