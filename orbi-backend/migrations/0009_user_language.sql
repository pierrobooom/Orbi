-- =============================================================================
-- 0009 — Per-user interaction language
-- =============================================================================
-- Everything in the pipeline assumed English: Deepgram was pinned to "en",
-- the sanitizer stripped only English lead-ins ("I need to", "remind me to"),
-- the time extractor matched only English clock phrases, and every prompt was
-- written in English so replies came back in English regardless of input.
--
-- `language` is a BCP-47 tag. pt-PT is European Portuguese specifically —
-- distinct from pt-BR in vocabulary ("telemóvel" vs "celular") and in how
-- Deepgram's model handles the accent.
--
-- Default stays 'en-GB': existing users see no behaviour change, and the app
-- is GBP/UK-centric already (finance categorisation is built around Tesco,
-- TfL, HMRC).
-- =============================================================================

alter table user_preferences
    add column if not exists language text not null default 'en-GB';

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'user_preferences_language_check'
    ) then
        alter table user_preferences
            add constraint user_preferences_language_check check (
                language in ('en-GB', 'en-US', 'pt-PT')
            );
    end if;
end $$;

comment on column user_preferences.language is
    'BCP-47 tag driving speech-to-text language, prompt response language, '
    'and which locale pack the sanitizer and time extractor use.';
