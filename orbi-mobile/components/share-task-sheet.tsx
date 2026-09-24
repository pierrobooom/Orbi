// Invite someone to a task, and show who is already on it.
//
// WHY AN EMAIL FIELD AND NOT A CONTACT PICKER
// A contact picker needs the phone's address book, which is a permission
// prompt asking for everyone the user knows in order to send one invitation.
// Typing an address is slower and asks for nothing.
//
// WHAT THE CONFIRMATION DELIBERATELY DOES NOT SAY
// Never whether that address has an Orbi account. The server does not tell
// the client, and the client must not imply it either — "invitation sent"
// reads the same whether they joined last year or have never heard of it,
// which is the point. Otherwise this screen becomes a way to check whether
// any given person uses the app.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ActionBar } from "@/components/action-bar";
import { translate, useT } from "@/i18n";
import { ApiError, shareTask, type SharingState } from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

interface Props {
  visible: boolean;
  taskId: string;
  taskTitle: string;
  /** Current participants and votes, so the sheet can show who is already
   * here rather than only offering to add more. */
  sharing: SharingState | null;
  onClose: () => void;
  onShared: () => void;
}

/** A light sanity check, not validation.
 *
 * The server validates properly; this only stops the obvious typo before a
 * round trip. Anything stricter starts rejecting addresses that genuinely
 * exist, which is a worse failure than accepting one that does not. */
function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 3 && trimmed.includes("@") && !trimmed.includes(" ");
}

export function ShareTaskSheet({
  visible,
  taskId,
  taskTitle,
  sharing,
  onClose,
  onShared,
}: Props) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const onSend = async () => {
    const address = email.trim().toLowerCase();
    if (!looksLikeEmail(address) || busy) return;
    setBusy(true);
    try {
      await shareTask(taskId, address);
      setEmail("");
      onShared();
      onClose();
      Alert.alert(
        translate("Invitation sent"),
        translate("They'll see it when they next open Orbi."),
      );
    } catch (e) {
      Alert.alert(
        translate("Could not share"),
        e instanceof ApiError ? e.message : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const accepted = (sharing?.shares ?? []).filter((s) => s.status === "accepted");
  const pending = (sharing?.shares ?? []).filter((s) => s.status === "pending");

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* The sheet is pinned to the bottom, which is exactly where the
          keyboard appears — so focusing the email field buried the whole
          thing, title and participants included. Lifting it keeps the
          context visible while typing, which is the point of showing who
          is already on the task. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.title} numberOfLines={2}>
              {t("Share “{title}”", { title: taskTitle })}
            </Text>

            <Text style={styles.explainer}>
              {t(
                "They get their own copy of this bubble. It closes when most of you agree it's done.",
              )}
            </Text>

            <View style={styles.inputRow}>
              <MaterialIcons name="alternate-email" size={18} color={colors.inkDim} />
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder={t("their@email.com")}
                placeholderTextColor={colors.inkDim}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                returnKeyType="send"
                onSubmitEditing={onSend}
              />
            </View>

            {accepted.length > 0 || pending.length > 0 ? (
              <View style={styles.people}>
                {accepted.map((s) => (
                  <View key={s.id} style={styles.person}>
                    <MaterialIcons
                      name={s.completed_at ? "check-circle" : "person"}
                      size={16}
                      color={s.completed_at ? colors.health : colors.inkDim}
                    />
                    <Text style={styles.personText} numberOfLines={1}>
                      {s.invited_email}
                    </Text>
                    <Text style={styles.personState}>
                      {s.completed_at ? t("says done") : t("on it")}
                    </Text>
                  </View>
                ))}
                {pending.map((s) => (
                  <View key={s.id} style={styles.person}>
                    <MaterialIcons name="schedule" size={16} color={colors.inkDim} />
                    <Text style={styles.personText} numberOfLines={1}>
                      {s.invited_email}
                    </Text>
                    <Text style={styles.personState}>{t("not answered")}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            <ActionBar
              primary={{
                label: t("Send invitation"),
                onPress: onSend,
                disabled: !looksLikeEmail(email),
                busy,
              }}
              secondary={{ label: t("Close"), onPress: onClose }}
              style={styles.actions}
            />
            </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = themed(() => StyleSheet.create({
  flex: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.panel,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 20,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  explainer: {
    color: colors.inkDim,
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 8,
    marginBottom: 16,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  input: { flex: 1, color: colors.ink, fontSize: 15, padding: 0 },
  people: { marginTop: 14, gap: 10 },
  person: { flexDirection: "row", alignItems: "center", gap: 10 },
  personText: { flex: 1, color: colors.ink, fontSize: 13 },
  personState: { color: colors.inkDim, fontSize: 11 },
  actions: { borderTopWidth: 0, backgroundColor: "transparent", paddingHorizontal: 0 },
}));
