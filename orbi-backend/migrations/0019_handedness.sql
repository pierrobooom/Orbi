-- =============================================================================
-- Which hand is holding the phone.
--
-- Orbi puts Close in the top-left and Save in the top-right. Both corners sit
-- outside the arc a thumb can reach on a modern phone, and which corner is
-- worse depends entirely on which hand you hold it in — a fact the app had no
-- way of knowing and therefore guessed, identically, for everyone.
--
-- Stored on the server rather than the device because it is a property of the
-- person, not the handset: someone who switches to a tablet or reinstalls
-- should not have to rediscover the setting.
--
-- Defaults to right, which is roughly 90% of people. The point is not that
-- the default is clever; it is that the other 10% can change it.
-- =============================================================================

alter table user_preferences
    add column if not exists handedness text not null default 'right'
        check (handedness in ('right', 'left'));

comment on column user_preferences.handedness is
    'Which thumb reaches most comfortably. Mirrors header actions, floating '
    'buttons and sheet alignment. Presentation only — it never changes what '
    'an action does, only which side of the screen it sits on.';
