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
const ACTION_REPLY = "reply";

const SNOOZE_MINUTES = 60;

/** Payload the server attaches to every reminder push. */
interface ReminderData {
  kind?: string;
  planId?: string;
  taskId?: string;
}

/** Register the action sets. Safe to call repeatedly — it's an upsert. */
export async function registerNotificationCategories(): Promise<void> {
  // opensAppToForeground: false is the whole point. "Done" that yanks you
  // into the app has not saved you anything; the value is disposing of
  // the thing without leaving your lock screen.
  const done = {
    identifier: ACTION_DONE,
    buttonTitle: translate("Done"),
    options: { opensAppToForeground: false },
  };
  const snooze = {
    identifier: ACTION_SNOOZE,
    buttonTitle: translate("Snooze 1h"),
    options: { opensAppToForeground: false },
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
    options: { opensAppToForeground: false },
  };

  try {
    await Promise.all([
      // Before the deadline there is nothing to mark done yet — the task
      // hasn't come round. Snoozing the warning is the only sane verb.
      Notifications.setNotificationCategoryAsync(CATEGORY_LEAD, [snooze, done]),
      Notifications.setNotificationCategoryAsync(CATEGORY_DUE, [done, snooze]),
      // The chase is the one that asks a question, so it is the one that
      // earns a free-text answer.
      Notifications.setNotificationCategoryAsync(CATEGORY_CHASE, [done, snooze, reply]),
    ]);
  } catch (e) {
    // Never fatal. A device that won't take categories still receives
    // perfectly good notifications, just without buttons.
    console.warn("Notification categories not registered:", e);
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
      // Default action — the user tapped the notification body. Opening
      // the app is handled by the router; nothing to record.
      return;
    }

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
    if (!session) return;
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
