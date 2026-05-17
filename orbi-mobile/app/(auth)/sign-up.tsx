// Email + password sign-up. Collects full_name so we can PATCH /users/me
// immediately after Supabase creates the account — the auth.users trigger
// (migrations/0003_user_profile_autocreate.sql) seeds an empty profile row
// at insert time, and this PATCH fills in the name.

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

import { patchMyProfile } from "@/services/api";
import { supabase } from "@/services/supabase";
import { colors } from "@/theme/colors";

export default function SignUpScreen() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const canSubmit =
    fullName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 6 &&
    !submitting;

  const onSubmit = async () => {
    setError(null);
    setInfo(null);
    setSubmitting(true);

    const { data, error: authError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });

    if (authError) {
      setSubmitting(false);
      setError(authError.message);
      return;
    }

    // Two outcomes from signUp:
    //   1. Confirmations off (dev): we have a session immediately — PATCH
    //      the profile and let the root layout redirect us into (tabs).
    //   2. Confirmations on (prod): no session yet; user must click the
    //      email link. Show a message and stop here.
    if (!data.session) {
      setSubmitting(false);
      setInfo("Check your email to confirm your account, then sign in.");
      return;
    }

    try {
      await patchMyProfile({ full_name: fullName.trim() });
    } catch (e) {
      // Don't block sign-up on a profile patch failure — the trigger has
      // already created the row with an empty full_name. The user can
      // update their name later from the (future) settings screen.
      // We log to console for the dev to notice during testing.
      // eslint-disable-next-line no-console
      console.warn("PATCH /users/me failed after signup:", e);
    }
    setSubmitting(false);
    // onAuthStateChange fires SIGNED_IN; root layout redirects.
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.body}>
          <Text style={styles.title}>Create your universe</Text>
          <Text style={styles.subtitle}>Free plan, no card required</Text>

          <View style={styles.field}>
            <Text style={styles.label}>Full name</Text>
            <TextInput
              value={fullName}
              onChangeText={setFullName}
              autoCapitalize="words"
              autoCorrect={false}
              textContentType="name"
              placeholder="Jane Doe"
              placeholderTextColor={colors.inkDim}
              style={styles.input}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="you@example.com"
              placeholderTextColor={colors.inkDim}
              style={styles.input}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              placeholder="At least 6 characters"
              placeholderTextColor={colors.inkDim}
              style={styles.input}
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {info ? <Text style={styles.info}>{info}</Text> : null}

          <Pressable
            onPress={onSubmit}
            disabled={!canSubmit}
            style={[styles.primary, !canSubmit && styles.primaryDisabled]}
          >
            {submitting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.primaryText}>Create account</Text>
            )}
          </Pressable>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Already have an account?</Text>
            <Link href={"/(auth)/sign-in" as Href} replace style={styles.footerLink}>
              Sign in
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
  info: { color: colors.health, fontSize: 13, marginTop: 4, marginBottom: 8 },
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
