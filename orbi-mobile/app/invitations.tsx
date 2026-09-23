// Tasks other people want you on.
//
// WHY THE WHOLE TASK IS SHOWN, NOT JUST THE TITLE
// Accepting puts a bubble in your universe and signs you up to confirming
// when it is finished. "Ana shared a task with you" is not enough to decide
// on — the title, when it is due and how urgent it is are exactly what the
// decision needs, so they are all here before anyone commits to anything.
//
// WHY DECLINING IS QUIET
// Nothing is sent to the sender. Turning down an invitation is a small
// private act, and a notification announcing it would make it a social one
// with nothing anybody can do in response.
//
// WHY THERE IS NO CLUSTER PICKER HERE
// Accepting should not also require a filing decision. The task lands in
// Adrift and can be moved like anything else — asking two questions when
// one is needed is how a two-tap action becomes a screen people leave.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/screen-header";
import { translate, useT } from "@/i18n";
import {
  acceptShare,
  declineShare,
  getIncomingShares,
  type ShareInvitation,
} from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";

function dueLabel(iso: string | null, t: (k: string, v?: any) => string): string {
  if (!iso) return t("No date");
  const due = new Date(iso);
  const days = Math.round((due.getTime() - Date.now()) / 86400000);
  if (days < 0) return t("Overdue");
  if (days === 0) return t("Today");
  if (days === 1) return t("Tomorrow");
  return due.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export default function InvitationsScreen() {
  const t = useT();
  const hydrate = useUniverseStore((s) => s.hydrate);

  const [invitations, setInvitations] = useState<ShareInvitation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setInvitations(await getIncomingShares());
    } catch {
      setInvitations((current) => current ?? []);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onAccept = async (invitation: ShareInvitation) => {
    setBusy(invitation.share.id);
    try {
      await acceptShare(invitation.share.id);
      // Remove it here AND rehydrate the universe: the task is now a bubble
      // and should be there when the user goes looking for it, not on the
      // next cold start.
      setInvitations((current) =>
        (current ?? []).filter((i) => i.share.id !== invitation.share.id),
      );
      await hydrate();
    } catch (e) {
      Alert.alert(translate("Could not accept"), String(e));
    } finally {
      setBusy(null);
    }
  };

  const onDecline = (invitation: ShareInvitation) => {
    Alert.alert(
      translate("Decline this?"),
      translate("They won't be told. You can be invited again later."),
      [
        { text: translate("Cancel"), style: "cancel" },
        {
          text: translate("Decline"),
          style: "destructive",
          onPress: async () => {
            setBusy(invitation.share.id);
            try {
              await declineShare(invitation.share.id);
              setInvitations((current) =>
                (current ?? []).filter((i) => i.share.id !== invitation.share.id),
              );
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <ScreenHeader title={t("Invitations")} />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            tintColor={colors.accent}
          />
        }
      >
        {invitations === null ? (
          <ActivityIndicator color={colors.accent} style={styles.loader} />
        ) : invitations.length === 0 ? (
          <View style={styles.empty}>
            <MaterialIcons name="drafts" size={28} color={colors.inkDim} />
            <Text style={styles.emptyTitle}>{t("Nothing waiting")}</Text>
            <Text style={styles.emptyBody}>
              {t(
                "When someone shares a task with you, it turns up here before it joins your universe.",
              )}
            </Text>
          </View>
        ) : (
          invitations.map((invitation) => (
            <View key={invitation.share.id} style={styles.card}>
              <Text style={styles.from}>
                {t("{who} shared this with you", {
                  who: invitation.shared_by_name ?? t("Someone"),
                })}
              </Text>
              <Text style={styles.title} numberOfLines={3}>
                {invitation.task.title}
              </Text>
              <View style={styles.meta}>
                <MaterialIcons name="schedule" size={14} color={colors.inkDim} />
                <Text style={styles.metaText}>
                  {dueLabel(invitation.task.due_at, t)}
                </Text>
              </View>

              {/* Said plainly before accepting, because it is the part that
                  is not obvious: joining means being asked to confirm when
                  it is finished, not just watching someone else's list. */}
              <Text style={styles.consequence}>
                {t("If you join, it closes only when you both agree it's done.")}
              </Text>

              <View style={styles.actions}>
                <Pressable
                  onPress={() => onDecline(invitation)}
                  disabled={busy !== null}
                  style={[styles.declineBtn, busy && styles.dim]}
                >
                  <Text style={styles.declineText}>{t("No thanks")}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onAccept(invitation)}
                  disabled={busy !== null}
                  style={[styles.acceptBtn, busy && styles.dim]}
                >
                  {busy === invitation.share.id ? (
                    <ActivityIndicator color={colors.canvas} size="small" />
                  ) : (
                    <Text style={styles.acceptText}>{t("Join")}</Text>
                  )}
                </Pressable>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  body: { padding: 16, paddingBottom: 48, gap: 12 },
  loader: { marginTop: 40 },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  from: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: "700", marginTop: 8, lineHeight: 23 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  metaText: { color: colors.inkDim, fontSize: 12 },
  consequence: {
    color: colors.inkDim,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  actions: { flexDirection: "row", gap: 10, marginTop: 16 },
  declineBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  declineText: { color: colors.inkDim, fontSize: 15, fontWeight: "600" },
  acceptBtn: {
    flex: 2,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  acceptText: { color: colors.canvas, fontSize: 15, fontWeight: "700" },
  dim: { opacity: 0.5 },
  empty: { alignItems: "center", paddingTop: 60, paddingHorizontal: 28, gap: 8 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  emptyBody: { color: colors.inkDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
});
