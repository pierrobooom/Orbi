// Action buttons on reminder notifications, and what they do.
//
// A reminder you can only read is a reminder you have to act on twice:
// once to acknowledge it, then again inside the app. These buttons close
// that loop from the lock screen.
//
// HOW THE TWO HALVES MEET
// The server names a category on each push (`categoryId`, top-level —
// see services/push.py). The CLIENT is what actually defines what that
// category contains, by calling setNotificationCategoryAsync at runtime.
// Neither half works alone: an unregistered category renders as a plain
// notification with no buttons and no error anywhere.
//
// WHY THERE IS NO MICROPHONE BUTTON
// iOS does not let any app record audio from a notification — not Orbi,
// not Duolingo, not anything. What it does allow is a text-input action,
// and the keyboard that opens has the system dictation mic on it. So the
// user taps "Responder", taps the mic, speaks, and iOS transcribes it for
// free. That text goes through the same voice-update agent a spoken edit
// would, which is why this is a genuine substitute rather than a
// consolation prize.
//
// EXPO GO
// Categories are registered at runtime, so this may well work in Expo Go
// on iOS. It is not documented to, and remote push in Expo Go is already
// a degraded path, so treat a missing set of buttons there as expected
// rather than as a bug — the same code is what a dev build will use.

import * as Notifications from "expo-notifications";
import { router, useRootNavigationState, type Href } from "expo-router";
import { useEffect } from "react";

import {
  markNotificationAnswered,
  snoozeNotification,
  updateTask,
  voiceUpdateTask,
} from "@/services/api";
import { translate } from "@/i18n";
import { useAuthStore } from "@/stores/authStore";
import { useUniverseStore } from "@/stores/universeStore";

// Must match _CATEGORIES in services/reminder_dispatcher.py.
const CATEGORY_LEAD = "orbi.task.lead";
const CATEGORY_DUE = "orbi.task.due";
const CATEGORY_CHASE = "orbi.task.chase";

const ACTION_DONE = "done";
const ACTION_SNOOZE = "snooze";
const ACTION_SNOOZE_TOMORROW = "snooze_tomorrow";
const ACTION_OPEN = "open";
const ACTION_REPLY = "reply";

const SNOOZE_MINUTES = 60;

// Where "tomorrow" lands. Early enough to be the start of the day, late
// enough to be outside anyone's default quiet hours.
const TOMORROW_HOUR = 9;

/** Minutes from now until tomorrow morning, in the device's own zone.
 *
 * Computed on the phone rather than the server because the phone is what
 * knows where it is, and "tomorrow" is a wall-clock idea — 9am where the
 * user is standing, not 9am UTC. The server clamps this to a week.
 */
function minutesUntilTomorrowMorning(): number {
  const now = new Date();
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(TOMORROW_HOUR, 0, 0, 0);
  return Math.max(5, Math.round((target.getTime() - now.getTime()) / 60000));
}

/** Payload the server attaches to every reminder push. */
interface ReminderData {
  kind?: string;
  planId?: string;
  taskId?: string;
}

// Whether Done / Snooze / Tomorrow / Reply act WITHOUT opening the app.
//
// FALSE, AND WHY — these buttons did nothing at all.
// An action with opensAppToForeground: false is handled by iOS in the
// background, and the app's JavaScript only hears about it through a
// registered background task (Notifications.registerTaskAsync with
// expo-task-manager). None was ever registered. The listener in this file
// only runs while the app is open — so pressing "Tomorrow" on the lock
// screen changed nothing, anywhere, and said nothing: the task stayed due
// today, red, and the server log shows no request at all.
//
// Background tasks also do not run in Expo Go, so this could not have been
// made to work in the environment the app is tested in. Opening the app is
// the version that works everywhere, and it has a real upside: you see the
// task move, rather than trusting that it did.
//
// Flip to true only together with a registered background task, and only
// after checking it on a development build.
const ACT_IN_BACKGROUND = false;
const quietly = { opensAppToForeground: !ACT_IN_BACKGROUND };

/** Register the action sets. Safe to call repeatedly — it's an upsert. */
export async function registerNotificationCategories(): Promise<void> {
  const done = {
    identifier: ACTION_DONE,
    buttonTitle: translate("Done"),
    options: quietly,
  };
  const snooze = {
    identifier: ACTION_SNOOZE,
    buttonTitle: translate("Snooze 1h"),
    options: quietly,
  };
  const snoozeTomorrow = {
    identifier: ACTION_SNOOZE_TOMORROW,
    buttonTitle: translate("Tomorrow"),
    options: quietly,
  };
  // The escape hatch from a fixed menu. Two canned delays cover most
  // cases and nothing covers the rest, so this one deliberately DOES open
  // the app — straight onto the task, where the date picker lives.
  const pickTime = {
    identifier: ACTION_OPEN,
    buttonTitle: translate("Pick a time"),
    options: { opensAppToForeground: true },
  };
  const reply = {
    identifier: ACTION_REPLY,
    buttonTitle: translate("Reply"),
    // textInput is what puts the keyboard — and therefore the system
    // dictation mic — on the lock screen.
    textInput: {
      submitButtonTitle: translate("Send"),
      placeholder: translate("What happened?"),
    },
    options: quietly,
  };

  // Order matters more than the list does: iOS shows only the first two
  // as buttons on a collapsed notification and hides the rest behind a
  // long-press, so the two most likely answers go first.
  try {
    await Promise.all([
      // Before the deadline, "done" is plausible (you did it early) but
      // postponing the warning is the commoner answer, so it leads.
      Notifications.setNotificationCategoryAsync(CATEGORY_LEAD, [
        snooze,
        done,
        snoozeTomorrow,
        pickTime,
      ]),
      Notifications.setNotificationCategoryAsync(CATEGORY_DUE, [
        done,
        snooze,
        snoozeTomorrow,
        pickTime,
      ]),
      // The chase is the one that asks a question, so it is the one that
      // earns a free-text answer.
      Notifications.setNotificationCategoryAsync(CATEGORY_CHASE, [
        done,
        snooze,
        snoozeTomorrow,
        pickTime,
        reply,
      ]),
    ]);
  } catch (e) {
    // Never fatal. A device that won't take categories still receives
    // perfectly good notifications, just without buttons.
    console.warn("Notification categories not registered:", e);
  }
}

/** Land the user on the task the notification was about.
 *
 * Not just "open the app": a reminder that dumps you on whatever screen
 * you last used has made you go and find the thing yourself, which is the
 * work the notification was supposed to save.
 *
 * Three steps, in order:
 *   1. the Universe tab, since that is where tasks live;
 *   2. drill into the task's cluster, so backing out of the detail leaves
 *      you looking at its bubble among its siblings rather than at the
 *      top-level cluster view;
 *   3. open the task itself, which is where the date picker is.
 *
 * Hydration comes first because a cold start has an empty store, and
 * entering a cluster we haven't loaded yet would focus on nothing.
 */
async function openTaskInUniverse(taskId: string): Promise<void> {
  const store = useUniverseStore.getState();
  try {
    if (store.serverTasks.length === 0) await store.hydrate();
  } catch {
    // Offline or the token expired. Still navigate — the Universe will
    // show its own error state, which beats silently doing nothing.
  }

  const task = useUniverseStore.getState().getServerTask(taskId);
  const clusterId = task?.parent_cluster_id;
  if (clusterId) {
    useUniverseStore.getState().enterCluster(clusterId);
  }

  router.navigate("/(tabs)" as Href);
  router.push({ pathname: "/task-detail", params: { id: taskId } });
}


/** Clear every delivered notification about one task.
 *
 * Reminders stack. A lead warning, the due one and a chase can all be
 * sitting in Notification Centre at once, and they are all asking the same
 * question. Answering any of them answers all of them, so leaving the
 * siblings there asks a question the user has already dealt with — and the
 * pile is what makes people turn reminders off altogether.
 *
 * iOS only auto-dismisses the exact notification that was actioned, so the
 * rest have to be cleared explicitly. Matching is on taskId from the push
 * payload rather than on the category, because the point is "this task",
 * not "this kind of reminder".
 */
export async function dismissDeliveredFor(taskId: string): Promise<void> {
  try {
    const delivered = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      delivered
        .filter((n) => {
          const d = (n.request.content.data ?? {}) as ReminderData;
          return d.taskId === taskId;
        })
        .map((n) =>
          Notifications.dismissNotificationAsync(n.request.identifier),
        ),
    );
  } catch (e) {
    // Best effort, and never fatal: tidying the tray must not be able to
    // undo the action the user actually asked for.
    console.warn("Could not clear delivered notifications:", e);
  }
}

/** Act on a button press. Exported so the background task can reuse it. */
export async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
): Promise<void> {
  const data = (response.notification.request.content.data ?? {}) as ReminderData;
  const { planId, taskId } = data;
  if (!taskId) return;

  const action = response.actionIdentifier;

  try {
    if (action === ACTION_DONE) {
      await updateTask(taskId, { status: "completed" });
      // Completing cancels the remaining reminders server-side (the PATCH
      // replans the task), so the plan only needs marking when we are NOT
      // completing.
    } else if (action === ACTION_SNOOZE) {
      if (planId) await snoozeNotification(planId, SNOOZE_MINUTES);
    } else if (action === ACTION_SNOOZE_TOMORROW) {
      if (planId) await snoozeNotification(planId, minutesUntilTomorrowMorning());
    } else if (
      action === ACTION_OPEN ||
      action === Notifications.DEFAULT_ACTION_IDENTIFIER
    ) {
      // Tapping the notification body, or choosing "Pick a time". Both
      // mean the same thing: take me to this task.
      await dismissDeliveredFor(taskId);
      await openTaskInUniverse(taskId);
      return;
    } else if (action === ACTION_REPLY) {
      const text = (response as { userText?: string }).userText?.trim();
      if (!text) return;
      // Applied directly rather than staged for review. Everywhere else
      // in the app a spoken edit is shown before it is saved, but there
      // is no review surface on a lock screen — offering one would mean
      // opening the app, which is the thing the user avoided by replying
      // from the notification.
      const result = await voiceUpdateTask(taskId, text);
      if (Object.keys(result.patch).length > 0) {
        await updateTask(taskId, result.patch);
      }
      if (planId) await markNotificationAnswered(planId);
    } else {
      // A dismissal, or an action from a future build we don't know yet.
      return;
    }

    // Done, snoozed or replied — whichever it was, the other reminders
    // about this task are now stale.
    await dismissDeliveredFor(taskId);

    // Pull the change back into the canvas so the bubble is already
    // correct if the app is open behind the notification.
    await useUniverseStore.getState().hydrate();
  } catch (e) {
    console.warn(`Notification action "${action}" failed:`, e);
  }
}

// Responses already acted on, so a cold-start replay can't double-apply.
// Ids are per-notification and never reused.
const handled = new Set<string>();

function responseId(response: Notifications.NotificationResponse): string {
  return `${response.notification.request.identifier}:${response.actionIdentifier}`;
}

async function handleOnce(
  response: Notifications.NotificationResponse,
): Promise<void> {
  const id = responseId(response);
  if (handled.has(id)) return;
  handled.add(id);
  await handleNotificationResponse(response);
}

/** Register categories and listen for button presses. */
export function useNotificationActions() {
  const session = useAuthStore((s) => s.session);
  // Truthy only once the root navigator exists. See the cold-start effect.
  const navigationReady = !!useRootNavigationState()?.key;

  useEffect(() => {
    // Categories are per-app, not per-user, but registering only once
    // signed in keeps the button labels in the language the user chose,
    // which is loaded with their preferences.
    if (!session) return;
    registerNotificationCategories();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        void handleOnce(response);
      },
    );
    return () => subscription.remove();
  }, [session]);

  useEffect(() => {
    // Cold start. Pressing "Done" on a killed app fires no listener —
    // there is no JS running to hear it — so without this the task is
    // never completed and the user is told about it again tomorrow. iOS
    // hands the response to the next launch instead, and that is the only
    // chance to honour it.
    //
    // Gated on the navigator existing, because this effect runs from a
    // component that RENDERS the navigator: on the first pass there is
    // nothing mounted to navigate, and a tap that should have opened the
    // task would silently do nothing.
    if (!session || !navigationReady) return;
    let cancelled = false;
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!cancelled && response) void handleOnce(response);
      })
      .catch(() => {
        /* nothing pending, or the platform declined to say */
      });
    return () => {
      cancelled = true;
    };
  }, [session]);
}
