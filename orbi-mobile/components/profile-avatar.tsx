// The profile picture, and the two ways of choosing one.
//
// WHY BOTH A PHOTO PICKER AND A FILE PICKER
// They are different places to most people. "A photo I took" lives in
// Photos; "the picture someone sent me" often lives in Files or iCloud
// Drive, and the photo picker cannot see it. Offering only one guarantees
// that half the time the picture the user has in mind is not on the list.
//
// WHAT IS SENT
// The photo picker crops to a square and re-encodes at reduced quality
// before anything leaves the phone. That is not only bandwidth: a modern
// phone photo is several megabytes, and the thing it ends up as here is a
// circle 96 points wide. The file picker cannot crop — it hands back a file
// as-is — so the server's size limit is the backstop for that route.
//
// WHERE IT PERSISTS
// Nowhere on the device. The upload returns the updated profile and the URL
// lives on that row, so signing in anywhere shows the same picture. The
// only local state here is what is on screen right now.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as DocumentPicker from "expo-document-picker";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import React, { useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { translate, useT } from "@/i18n";
import { ApiError, removeAvatar, uploadAvatar } from "@/services/api";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

interface Props {
  /** Current picture, or null for the initials fallback. */
  url: string | null;
  /** Used for the initials, and read aloud by screen readers. */
  name: string;
  /** Fired with the new URL (or null) once the server has accepted it. */
  onChanged: (url: string | null) => void;
}

const SIZE = 72;

/** Up to two initials from a name, for when there is no picture.
 *
 * Better than a generic silhouette because it differs per person, which is
 * the entire job of an avatar in a list of people. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function ProfileAvatar({ url, name, onChanged }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const send = async (uri: string, mimeType?: string) => {
    setBusy(true);
    try {
      const profile = await uploadAvatar(uri, mimeType);
      onChanged(profile.avatar_url);
    } catch (e) {
      // Logged as well as shown. The first version of this failed with a
      // bare "Network request failed" and no server-side trace, and there
      // was nothing on screen or in the logs to say which half was at
      // fault. The uri is the part that identifies the case.
      console.warn("Avatar upload failed:", uri, e);
      // The server's message is written for a person ("That image is larger
      // than 5 MB"), so it is worth showing. Anything else is infrastructure
      // and gets a plain sentence instead.
      Alert.alert(
        translate("Could not save"),
        e instanceof ApiError
          ? e.message
          : translate("Could not upload that picture. Try again."),
      );
    } finally {
      setBusy(false);
    }
  };

  const fromPhotos = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        translate("Photos access needed"),
        translate("Orbi needs access to your photos to set a picture. You can turn it on in Settings."),
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      // Square, because the frame it lands in is a circle. Letting the user
      // crop beats centre-cropping for them and hoping their face survived.
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await send(asset.uri, asset.mimeType);
  };

  const fromFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["image/*"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await send(asset.uri, asset.mimeType ?? undefined);
  };

  const clear = async () => {
    setBusy(true);
    try {
      const profile = await removeAvatar();
      onChanged(profile.avatar_url);
    } catch {
      Alert.alert(translate("Could not save"), translate("Try again."));
    } finally {
      setBusy(false);
    }
  };

  const choose = () => {
    const options = [
      t("Choose a photo"),
      t("Choose a file"),
      ...(url ? [t("Remove picture")] : []),
      t("Cancel"),
    ];
    const cancelIndex = options.length - 1;
    const destructiveIndex = url ? 2 : undefined;

    const run = (index: number) => {
      if (index === 0) void fromPhotos();
      else if (index === 1) void fromFiles();
      else if (url && index === 2) void clear();
    };

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex, destructiveButtonIndex: destructiveIndex },
        run,
      );
      return;
    }
    // Android has no action sheet primitive. An Alert with the same choices
    // is the closest thing that needs no extra dependency.
    Alert.alert(t("Profile picture"), undefined, [
      { text: options[0], onPress: () => run(0) },
      { text: options[1], onPress: () => run(1) },
      ...(url ? [{ text: options[2], style: "destructive" as const, onPress: () => run(2) }] : []),
      { text: t("Cancel"), style: "cancel" as const },
    ]);
  };

  return (
    <View style={styles.row}>
      <Pressable
        onPress={choose}
        disabled={busy}
        style={styles.frame}
        accessibilityRole="button"
        accessibilityLabel={t("Change profile picture")}
      >
        {url ? (
          <Image
            source={{ uri: url }}
            style={styles.image}
            contentFit="cover"
            // The URL changes whenever the picture does, so a long memory
            // here never shows a stale face.
            cachePolicy="memory-disk"
            transition={150}
          />
        ) : (
          <View style={[styles.image, styles.initialsBox]}>
            <Text style={styles.initials}>{initialsOf(name)}</Text>
          </View>
        )}

        {busy ? (
          <View style={[styles.image, styles.busyVeil]}>
            <ActivityIndicator color="white" />
          </View>
        ) : (
          <View style={styles.badge}>
            <MaterialIcons name="photo-camera" size={13} color={colors.canvas} />
          </View>
        )}
      </Pressable>

      <View style={styles.copy}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Pressable onPress={choose} disabled={busy} hitSlop={8}>
          <Text style={styles.action}>
            {url ? t("Change picture") : t("Add a picture")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 4 },
  frame: { width: SIZE, height: SIZE },
  image: { width: SIZE, height: SIZE, borderRadius: SIZE / 2 },
  initialsBox: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  initials: { color: colors.inkDim, fontSize: 24, fontWeight: "700" },
  busyVeil: {
    position: "absolute",
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.canvas,
  },
  copy: { flex: 1, gap: 3 },
  name: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  action: { color: colors.accent, fontSize: 13, fontWeight: "600" },
}));
