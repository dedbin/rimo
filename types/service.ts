export type BoardRole = "owner" | "editor" | "viewer";

export interface BoardAccess {
  boardId: string;
  userId: string;
  role: BoardRole;
}

export interface BoardSummary {
  id: string;
  title: string;
  ownerId: string;
  authorName: string;
  imageUrl: string;
  createdAt: number;
  updatedAt: number;
  isFavorite: boolean;
  role: BoardRole;
}

export interface AssetSummary {
  id: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

export interface BoardSession {
  board: BoardSummary;
  role: BoardRole;
  user: { id: string; name: string; image?: string | null };
  connection: { url: string; token: "cookie" };
}

export interface BoardInvite {
  id: string;
  role: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}
