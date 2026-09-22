-- =============================================================================
-- Where the user put it.
--
-- Bubbles can now be picked up and dropped, and until this migration that
-- placement lived only in a shared value on the UI thread: it survived a
-- resync, and died with the app. Dragging something to where it belongs and
-- finding it back in the pile tomorrow is worse than not being able to drag
-- it at all — the first teaches the user the app forgets.
--
-- WHY NORMALISED, NOT PIXELS
-- The drag produces screen coordinates, and screens differ. A bubble dropped
-- at x=320 on a Pro Max is off-canvas on an SE, and the same account opened
-- on a tablet would find its whole universe crushed into the left third.
-- Stored as a 0..1 fraction of the canvas, so a placement means "two thirds
-- across" rather than "320 pixels", and survives a change of device, an
-- orientation change, and any future change to the canvas size.
--
-- NULL MEANS "NEVER PLACED", AND THAT IS NOT THE SAME AS 0
-- A bubble the user has not touched should keep being arranged by the layout
-- pass, which spaces things out as tasks come and go. Storing 0,0 as a
-- default would pin every bubble to the top-left corner and read as a
-- catastrophic layout bug on first launch.
-- =============================================================================

alter table task_bubbles
    add column if not exists canvas_x double precision,
    add column if not exists canvas_y double precision;

alter table clusters
    add column if not exists canvas_x double precision,
    add column if not exists canvas_y double precision;

comment on column task_bubbles.canvas_x is
    'Where the user dropped this bubble, as a 0..1 fraction of canvas width. '
    'NULL means they never moved it and the layout pass owns its position.';

comment on column clusters.canvas_x is
    'Where the user dropped this cluster, as a 0..1 fraction of canvas width. '
    'NULL means the weight-based layout still owns it.';
