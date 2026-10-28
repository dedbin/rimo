CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "isAnonymous" boolean NOT NULL DEFAULT false
);

CREATE TABLE session (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text
);
CREATE INDEX session_user_idx ON session("userId");
CREATE INDEX session_expiry_idx ON session("expiresAt");

CREATE TABLE account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX account_user_idx ON account("userId");

CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE boards (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  image_url text NOT NULL DEFAULT '/logo.svg',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boards_owner_idx ON boards(owner_id, updated_at DESC);

CREATE TABLE board_invites (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by text NOT NULL REFERENCES "user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX invites_board_idx ON board_invites(board_id);

CREATE TABLE board_members (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  invite_id uuid REFERENCES board_invites(id),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX members_user_idx ON board_members(user_id);
CREATE INDEX members_invite_idx ON board_members(invite_id);

CREATE TABLE board_favorites (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE board_documents (
  board_id uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  state bytea NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  saved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id uuid PRIMARY KEY,
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  uploaded_by text NOT NULL REFERENCES "user"(id),
  storage_key text NOT NULL UNIQUE,
  sha256 text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (board_id, sha256)
);
CREATE INDEX assets_board_idx ON assets(board_id);
