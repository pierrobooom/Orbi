// Add or edit a resource ("Casa 1", "Millie") or a unit inside one
// ("Quarto 3" with its tenant). A unit asks for the person and since when;
// a resource asks for a line of detail — an address, a breed, a plate.

import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { TextInput } from "@/components/text-input";
import { SafeAreaView } from "react-native-safe-area-context";

import { DateField } from "@/components/collection/date-field";
import { kit, TopBar } from "@/components/collection/kit";
import { useT } from "@/i18n";
import {
  ApiError,
  archiveResource,
  createResource,
  getResource,
  updateResource,
} from "@/services/api";
import { useUniverseStore } from "@/stores/universeStore";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

export default function ResourceEditor() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; cluster?: string; parent?: string }>();
  const editingId = params.id ? String(params.id) : null;

  const [loading, setLoading] = useState(Boolean(editingId));
  const [clusterId, setClusterId] = useState(params.cluster ? String(params.cluster) : "");
  const [parentId, setParentId] = useState<string | null>(params.parent ? String(params.parent) : null);
  const [name, setName] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [person, setPerson] = useState("");
  const [since, setSince] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isUnit = Boolean(parentId);

  useEffect(() => {
    if (!editingId) return;
    getResource(editingId)
      .then(({ resource }) => {
        setClusterId(resource.cluster_id);
        setParentId(resource.parent_id);
        setName(resource.name);
        setSubtitle(resource.subtitle ?? "");
        setPerson(resource.person_name ?? "");
        setSince(resource.since_on);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : t("Could not load this.")))
      .finally(() => setLoading(false));
  }, [editingId, t]);

  const save = async () => {
    if (!name.trim()) return setError(t("Give it a name."));
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      subtitle: subtitle.trim() || null,
      person_name: isUnit ? person.trim() || null : null,
      since_on: isUnit ? since : null,
    };
    try {
      if (editingId) {
        await updateResource(editingId, fields);
        router.back();
      } else {
        const created = await createResource({ cluster_id: clusterId, parent_id: parentId, ...fields });
        // Straight into it: a new room or cat is empty, and its first
        // routine is the next thing anyone adds.
        router.replace(`/collection/resource/${created.id}` as Href);
      }
      void useUniverseStore.getState().hydrate();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
      setBusy(false);
    }
  };

  const archive = () => {
    if (!editingId) return;
    Alert.alert(
      isUnit ? t("Archive this unit?") : t("Archive this?"),
      t("Its routines stop and their open periods close. Payment history is kept."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Archive"),
          style: "destructive",
          onPress: async () => {
            try {
              await archiveResource(editingId);
              void useUniverseStore.getState().hydrate();
              // Back to where it lived — the screen for it no longer exists.
              router.dismissTo(
                (parentId ? `/collection/resource/${parentId}` : `/collection/${clusterId}`) as Href,
              );
            } catch (e) {
              setError(e instanceof ApiError ? e.message : t("Could not save. Try again."));
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={kit.screen}>
        <View style={kit.centered}><ActivityIndicator color={colors.inkDim} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={kit.screen} edges={["top", "bottom"]}>
      <View>
        <TopBar icon="x" />
        <Pressable onPress={save} disabled={busy} style={styles.saveTop} accessibilityRole="button">
          {busy ? <ActivityIndicator color={colors.ink} /> : <Text style={styles.saveText}>{t("Save")}</Text>}
        </Pressable>
      </View>
      <KeyboardAvoidingView style={kit.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={kit.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>
            {editingId ? t("Edit") : isUnit ? t("New unit") : t("New")}
          </Text>

          <Text style={styles.label}>{t("Name")}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            style={styles.input}
            maxLength={60}
            autoFocus={!editingId}
            placeholder={isUnit ? t("Quarto 3, Loja, T1…") : t("Casa 1, Millie, Golf…")}
            placeholderTextColor={colors.inkDim}
          />

          {isUnit ? (
            <>
              <Text style={styles.label}>{t("Person")}</Text>
              <TextInput
                value={person}
                onChangeText={setPerson}
                style={styles.input}
                maxLength={60}
                placeholder={t("Who lives or pays here")}
                placeholderTextColor={colors.inkDim}
              />
              <Text style={styles.label}>{t("Since")}</Text>
              <DateField value={since} onChange={setSince} placeholder={t("Optional")} />
            </>
          ) : (
            <>
              <Text style={styles.label}>{t("Detail")}</Text>
              <TextInput
                value={subtitle}
                onChangeText={setSubtitle}
                style={styles.input}
                maxLength={80}
                placeholder={t("Address, breed, plate…")}
                placeholderTextColor={colors.inkDim}
              />
            </>
          )}

          {error ? <Text style={kit.error}>{error}</Text> : null}

          {editingId ? (
            <Pressable onPress={archive} style={styles.archive} accessibilityRole="button">
              <Text style={styles.archiveText}>{t("Archive")}</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = themed(() => StyleSheet.create({
  saveTop: { position: "absolute", right: 20, top: 16, minWidth: 48, alignItems: "flex-end" },
  saveText: { color: colors.ink, fontSize: 15.5, fontWeight: "800" },
  title: { color: colors.ink, fontSize: 23, fontWeight: "800", marginTop: 4 },
  label: {
    color: colors.inkDim,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 46,
    color: colors.ink,
    fontSize: 15,
  },
  archive: { alignSelf: "center", marginTop: 26, padding: 10 },
  archiveText: { color: colors.overdue, fontSize: 14, fontWeight: "700" },
}));
