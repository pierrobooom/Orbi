-- Profile picture.
--
-- A URL rather than the bytes. The image lives in Supabase Storage in the
-- public "avatars" bucket; this column only remembers where. Storing image
-- data in Postgres would bloat every row read of a table that is read on
-- almost every request, to serve a file the CDN is already better at.
--
-- WHY THIS SURVIVES A REINSTALL
-- It hangs off the profile, not off the device. Signing in on a new phone
-- reads the same row, so the picture comes back with the account. Nothing
-- about it is cached locally as the source of truth.
--
-- The stored object is named with a random id, so the URL is public but not
-- guessable from a user id or an email address. Replacing a picture writes a
-- new object and deletes the old one, which also busts any CDN cache — the
-- reason the filename is not simply the user id.

alter table user_profiles
    add column if not exists avatar_url text;

comment on column user_profiles.avatar_url is
    'Public URL of the profile picture in the avatars storage bucket. '
    'Null means no picture; the client falls back to initials.';
