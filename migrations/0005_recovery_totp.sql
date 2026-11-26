-- recovery_email: personal address an admin can send sign-in details to (new user, password reset).
-- totp_last_step: last accepted TOTP time step, so a code cannot be used twice (RFC 6238 section 5.2).
ALTER TABLE users ADD COLUMN recovery_email TEXT;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
