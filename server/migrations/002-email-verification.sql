ALTER TABLE "user"
  ADD COLUMN "registrationPending" boolean NOT NULL DEFAULT false;

CREATE TABLE email_verification_limits (
  key text PRIMARY KEY,
  "windowStart" timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0)
);

-- Only one email confirmation challenge may exist for an address.
-- Invalid guesses racing a resend must not recreate the previous code.
DELETE FROM verification old
USING verification newer
WHERE old.identifier LIKE 'email-verification-otp-%'
  AND old.identifier = newer.identifier
  AND (old."createdAt", old.id) < (newer."createdAt", newer.id);
CREATE UNIQUE INDEX verification_email_otp_unique ON verification(identifier)
  WHERE identifier LIKE 'email-verification-otp-%';
