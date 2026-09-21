// Which bank? — the first step of connecting an account.
//
// Until now the institution came from a server environment variable, which
// sent every user to whichever bank the developer had set. That is invisible
// until there is a second user, and then it is a bank login page for someone
// else's bank.
//
// WHY THE LIST IS FETCHED, NOT SHIPPED
// Providers add and remove institutions constantly, and a bank that has been
// pulled fails at its own login with a message the user cannot act on. The
// list is live, per country, and the server filters it to institutions that
// serve personal customers — a business-only bank looks identical here and
// then rejects them after they have typed their password.
//
// WHY SEARCH IS NOT OPTIONAL
// Portugal alone returns 45 institutions and Germany returns hundreds. A
// plain alphabetical list means scrolling past forty banks to find yours,
// which is the point at which people give up on a feature that was supposed
// to save them effort.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useT } from "@/i18n";
import { ApiError, listInstitutions, type Institution } from "@/services/api";
import { colors } from "@/theme/colors";

// The countries Orbi's users are actually likely to bank in, most likely
// first. Not the full EEA list: a picker of 31 countries to reach a picker
// of banks is two haystacks, and anyone outside these can still search.
const COUNTRIES: { code: string; name: string }[] = [
  { code: "PT", name: "Portugal" },
  { code: "ES", name: "España" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Deutschland" },
  { code: "IT", name: "Italia" },
  { code: "NL", name: "Nederland" },
  { code: "IE", name: "Ireland" },
  { code: "BE", name: "Belgique" },
  { code: "LU", name: "Luxembourg" },
  { code: "AT", name: "Österreich" },
  { code: "FI", name: "Suomi" },
  { code: "SE", name: "Sverige" },
  { code: "DK", name: "Danmark" },
  { code: "NO", name: "Norge" },
  { code: "PL", name: "Polska" },
  { code: "EE", name: "Eesti" },
];

/** Strip accents so "Montepio" finds "Montepío" and "caixa" finds "Caixa". */
function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export default function BankPickerScreen() {
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; name?: string }>();
  const accountId = (params.id ?? "").toString();
  const accountName = (params.name ?? "").toString();

  const [country, setCountry] = useState("PT");
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [countryOpen, setCountryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (code: string) => {
    setLoading(true);
    setError(null);
    try {
      setInstitutions(await listInstitutions(code));
    } catch (e) {
      setInstitutions([]);
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(country);
  }, [country, load]);

  const visible = useMemo(() => {
    const needle = normalise(query);
    if (!needle) return institutions;
    return institutions.filter((bank) => normalise(bank.name).includes(needle));
  }, [institutions, query]);

  const onPick = (bank: Institution) => {
    // Straight to the consent explainer, carrying the choice. The order
    // matters: pick the bank, understand what is about to happen, then
    // leave the app — not the other way round.
    router.push({
      pathname: "/connect-bank",
      params: {
        id: accountId,
        name: accountName,
        institution: bank.name,
        country: bank.country || country,
      },
    });
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerSide}>
          <MaterialIcons name="chevron-left" size={24} color={colors.inkDim} />
        </Pressable>
        <Text style={styles.headerTitle}>{t("Choose your bank")}</Text>
        <View style={styles.headerSide} />
      </View>

      <View style={styles.searchRow}>
        <MaterialIcons name="search" size={18} color={colors.inkDim} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("Search banks")}
          placeholderTextColor={colors.inkDim}
          style={styles.searchInput}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery("")} hitSlop={10}>
            <MaterialIcons name="close" size={18} color={colors.inkDim} />
          </Pressable>
        ) : null}
      </View>

      {/* A dropdown, not a scrolling strip of pips.
          The strip was clipped top and bottom: a horizontal ScrollView is a
          flex child like any other, so in a column it takes the height it is
          given rather than the height its content needs, and the labels were
          cut in half. Sixteen countries scrolling sideways was also the
          wrong shape for something people change once a year. */}
      <Pressable onPress={() => setCountryOpen(true)} style={styles.country}>
        <Text style={styles.countryLabel}>{t("Country")}</Text>
        <Text style={styles.countryValue}>
          {COUNTRIES.find((c) => c.code === country)?.name ?? country}
        </Text>
        <MaterialIcons name="expand-more" size={20} color={colors.inkDim} />
      </Pressable>

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loader} />
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>{t("Could not load the banks")}</Text>
          <Text style={styles.errorBody}>{error}</Text>
          <Pressable onPress={() => load(country)} style={styles.retryBtn}>
            <Text style={styles.retryText}>{t("Try again")}</Text>
          </Pressable>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.errorTitle}>
            {query ? t("No bank matches that") : t("No banks available here")}
          </Text>
          <Text style={styles.errorBody}>
            {query
              ? t("Check the spelling, or try another country.")
              : t("Your bank may not be reachable yet. You can import a statement instead.")}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => `${item.country}:${item.name}`}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onPick(item)}
              style={styles.row}
              android_ripple={{ color: colors.line }}
            >
              {/* A logo is how people recognise their bank — the name alone
                  is four near-identical strings in most countries. Falls
                  back to an initial rather than a broken image box. */}
              {item.logo ? (
                <Image
                  source={{ uri: item.logo }}
                  style={styles.logo}
                  resizeMode="contain"
                />
              ) : (
                <View style={[styles.logo, styles.logoFallback]}>
                  <Text style={styles.logoLetter}>
                    {item.name.charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <Text style={styles.bankName} numberOfLines={2}>
                {item.name}
              </Text>
              <MaterialIcons name="chevron-right" size={20} color={colors.inkDim} />
            </Pressable>
          )}
        />
      )}

      <Modal
        visible={countryOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCountryOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setCountryOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>{t("Country")}</Text>
            <ScrollView>
              {COUNTRIES.map((item) => {
                const active = country === item.code;
                return (
                  <Pressable
                    key={item.code}
                    onPress={() => {
                      setCountry(item.code);
                      setQuery("");
                      setCountryOpen(false);
                    }}
                    style={[styles.option, active && styles.optionSelected]}
                  >
                    <Text style={styles.optionLabel}>{item.name}</Text>
                    {active ? (
                      <MaterialIcons name="check" size={18} color={colors.accent} />
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  headerSide: { minWidth: 40, alignItems: "center" },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, padding: 0 },
  country: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
  },
  countryLabel: {
    color: colors.inkDim,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  countryValue: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: "600" },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    maxHeight: "70%",
    backgroundColor: colors.panel,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 16,
    paddingBottom: 28,
    paddingHorizontal: 14,
  },
  sheetTitle: {
    color: colors.inkDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingBottom: 8,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  optionSelected: { backgroundColor: colors.canvas },
  optionLabel: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  loader: { marginTop: 40 },
  list: { paddingBottom: 40 },
  separator: { height: 1, backgroundColor: colors.line, marginLeft: 68 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  logo: { width: 38, height: 38, borderRadius: 8, backgroundColor: colors.panel },
  logoFallback: { alignItems: "center", justifyContent: "center" },
  logoLetter: { color: colors.inkDim, fontSize: 16, fontWeight: "700" },
  bankName: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: "600" },
  centered: { flex: 1, alignItems: "center", paddingTop: 60, paddingHorizontal: 28 },
  errorTitle: { color: colors.ink, fontSize: 15, fontWeight: "600", marginBottom: 6 },
  errorBody: {
    color: colors.inkDim,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
    marginBottom: 16,
  },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
    borderColor: colors.line,
    borderWidth: 1,
  },
  retryText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
});
