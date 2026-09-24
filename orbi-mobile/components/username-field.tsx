// Choosing a username, inline in Settings.
//
// The number after the # is never typed. It is shown as a grey suffix on the
// field while you type, so it is obvious from the first keystroke that the
// name does not have to be unique — the most common worry anyone has when
// picking a handle is "is it taken", and here the answer is always no.
//
// Validation messages come from the server and are shown as they are. The
// rule has exactly one home (services/usernames.py); a copy of it in the app
// would drift, and a name the client accepts but the server refuses — or the
// reverse — is worse than one round trip.

import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useT } from "@/i18n";
import { ApiError, formatHandle, setUsername } from "@/services/api";
import { cue } from "@/services/feedback";
import { useProfileStore } from "@/stores/profileStore";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

export function UsernameField() {
  const t = useT();
  const username = useProfileStore((s) => s.username);
  const tag = useProfileStore((s) => s.usernameTag);
  const store = useProfileStore((s) => s.setUsername);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = formatHandle(username, tag);

  const start = () => {
    setDraft(username ?? "");
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    // Unchanged, byte for byte: nothing to ask the server. A case change is
    // still sent — it keeps the same number, but the spelling is theirs.
    if (name === username) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const profile = await setUsername(name);
      store(profile.username, profile.username_tag);
      cue("capture");
      setEditing(false);
    } catch (e) {
      cue("refuse");
      // The server's message is the translation key. Its wording is fixed
      // (services/usernames.py) and t() falls back to the key itself, so an
      // untranslated message still reads correctly in English rather than
      // disappearing.
      setError(
        e instanceof ApiError ? t(e.message) : t("Could not save that username."),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <Pressable
        onPress={start}
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel={handle ? `${t("Username")}: ${handle}` : t("Choose a username")}
      >
        <View style={styles.rowText}>
          <Text style={styles.label}>{t("Username")}</Text>
          {handle ? (
            <Text style={styles.value}>
              {username}
              <Text style={styles.tag}>{handle.slice(username?.length ?? 0)}</Text>
            </Text>
          ) : (
            <Text style={styles.placeholder}>{t("Choose a username")}</Text>
          )}
        </View>
        {/* "Edit", not "Change": that key is already a noun in Portuguese
            ("Alteração", as in a percentage change), and would render as one. */}
        <Text style={styles.action}>{handle ? t("Edit") : t("Choose")}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.editor}>
      <Text style={styles.label}>{t("Username")}</Text>
      <View style={styles.inputRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t("your name")}
          placeholderTextColor={colors.inkDim}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          maxLength={20}
          returnKeyType="done"
          onSubmitEditing={save}
        />
        {/* The suffix the server will add. The current number if the name
            is unchanged, a placeholder otherwise — the real one is not known
            until it is claimed, and inventing one would be a promise. */}
        <Text style={styles.suffix}>
          {draft.trim().toLowerCase() === (username ?? "").toLowerCase() && tag !== null
            ? `#${String(tag).padStart(4, "0")}`
            : "#····"}
        </Text>
      </View>
      <Text style={error ? styles.error : styles.hint}>
        {error ??
          t("Anyone can pick any name. The number is added for you, so no one else can be you.")}
      </Text>
      <View style={styles.buttons}>
        <Pressable onPress={() => setEditing(false)} style={styles.cancel} disabled={busy}>
          <Text style={styles.cancelText}>{t("Cancel")}</Text>
        </Pressable>
        <Pressable
          onPress={save}
          style={[styles.save, (!draft.trim() || busy) && styles.dim]}
          disabled={!draft.trim() || busy}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.canvas} />
          ) : (
            <Text style={styles.saveText}>{t("Save")}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
  },
  rowText: { flex: 1 },
  label: { color: colors.inkDim, fontSize: 12, fontWeight: "600" },
  value: { color: colors.ink, fontSize: 16, fontWeight: "600", marginTop: 3 },
  // The number is part of the handle but not part of the name; it is shown
  // quieter so the eye reads the name first.
  tag: { color: colors.inkDim, fontWeight: "500" },
  placeholder: { color: colors.inkDim, fontSize: 15, marginTop: 3 },
  action: { color: colors.ink, fontSize: 14, fontWeight: "600" },

  editor: { paddingVertical: 12, gap: 8 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: colors.panel,
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
    fontWeight: "600",
    paddingVertical: 12,
  },
  suffix: { color: colors.inkDim, fontSize: 16, fontWeight: "500" },
  hint: { color: colors.inkDim, fontSize: 12, lineHeight: 17 },
  error: { color: colors.overdue, fontSize: 12, lineHeight: 17 },
  buttons: { flexDirection: "row", gap: 10, marginTop: 4 },
  cancel: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelText: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  save: {
    flex: 2,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  saveText: { color: colors.canvas, fontSize: 15, fontWeight: "700" },
  dim: { opacity: 0.45 },
}));
