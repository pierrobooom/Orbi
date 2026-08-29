// Email + password sign-in. Google OAuth lands as a second button in the
// next slice; the layout already leaves room for it.

import { Link, type Href } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useT } from "@/i18n";
import { supabase } from "@/services/supabase";
import { colors } from "@/theme/colors";

export default function SignInScreen() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  const onSubmit = async () => {
    setError(null);
    setSubmitting(true);
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setSubmitting(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    // onAuthStateChange in authStore fires SIGNED_IN; root layout redirects.
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.body}>
          <Text style={styles.title}>{t("Welcome back")}</Text>
          <Text style={styles.subtitle}>{t("Sign in to your Orbi universe")}</Text>

          <View style={styles.field}>
            <Text style={styles.label}>{t("Email")}</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder={t("you@example.com")}
              placeholderTextColor={colors.inkDim}
              style={styles.input}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>{t("Password")}</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder="••••••••"
              placeholderTextColor={colors.inkDim}
              style={styles.input}
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            onPress={onSubmit}
            disabled={!canSubmit}
            style={[styles.primary, !canSubmit && styles.primaryDisabled]}
          >
            {submitting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.primaryText}>{t("Sign in")}</Text>
            )}
          </Pressable>

          <View style={styles.footer}>
            <Text style={styles.footerText}>{t("New to Orbi?")}</Text>
            <Link href={"/(auth)/sign-up" as Href} replace style={styles.footerLink}>
              {t("Create an account")}
            </Link>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  body: { flex: 1, paddingHorizontal: 24, paddingTop: 60, justifyContent: "flex-start" },
  title: { color: colors.ink, fontSize: 28, fontWeight: "700" },
  subtitle: { color: colors.inkDim, fontSize: 14, marginTop: 6, marginBottom: 28 },
  field: { marginBottom: 16 },
  label: { color: colors.inkDim, fontSize: 12, marginBottom: 6, letterSpacing: 0.5 },
  input: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.ink,
    fontSize: 15,
  },
  error: { color: colors.overdue, fontSize: 13, marginTop: 4, marginBottom: 8 },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "white", fontSize: 15, fontWeight: "700" },
  footer: { flexDirection: "row", justifyContent: "center", marginTop: 24, gap: 6 },
  footerText: { color: colors.inkDim, fontSize: 13 },
  footerLink: { color: colors.accent, fontSize: 13, fontWeight: "600" },
});
