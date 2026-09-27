// Shared pieces for the collection screens: the top bar, chips, the progress
// bar and ring, and how money, dates and repeats are written.
//
// Kept in one place so the five screens agree on every detail — a bar that
// fills differently on the house screen than on the room screen reads as two
// different numbers.

import Feather from "@expo/vector-icons/Feather";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { useRouter } from "expo-router";
import React, { useEffect } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { translate, useLocaleStore } from "@/i18n";
import type { CollectionRoutine, RoutineFrequency } from "@/services/api";
import { colors } from "@/theme/colors";
import { DISPLAY } from "@/theme/fonts";
import { EXPRESSIVE, timing } from "@/theme/motion";
import { themed } from "@/theme/themed";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const isPt = () => useLocaleStore.getState().language.startsWith("pt");

/** "€1.150" / "€550,50" in Portuguese; "€1,150" / "€550.50" in English. */
export function money(amount: string | number | null | undefined, currency = "EUR"): string {
  const value = Number(amount ?? 0);
  const symbol = ({ EUR: "€", GBP: "£", USD: "$" } as Record<string, string>)[currency] ?? `${currency} `;
  const whole = Number.isInteger(value);
  const [int, dec] = Math.abs(value).toFixed(whole ? 0 : 2).split(".");
  const sep = isPt() ? "." : ",";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const text = dec ? `${grouped}${isPt() ? "," : "."}${dec}` : grouped;
  return `${value < 0 ? "-" : ""}${symbol}${text}`;
}

/** "400", "400,50", "400.50", "1.050,50" → a number, or NaN.
 *
 * People type the way they write money: a Portuguese "1.050,50" has a dot
 * for thousands and a comma for cents. When both appear, the dots are
 * thousands; a lone comma is the decimal point.
 */
export function parseAmount(text: string): number {
  let cleaned = text.replace(/[^\d,.]/g, "");
  if (cleaned.includes(",") && cleaned.includes(".")) cleaned = cleaned.replace(/\./g, "");
  cleaned = cleaned.replace(",", ".");
  return cleaned ? Number(cleaned) : NaN;
}

const MONTHS_PT = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MONTHS_PT_LONG = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
  "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_EN_LONG = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
const WEEKDAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A calendar date from "YYYY-MM-DD", at local noon so no zone shifts it. */
export function day(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

export function todayIso(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "15 out" / "15 Oct", with the year only when it is not this year. */
export function shortDate(iso: string): string {
  const d = day(iso);
  const month = (isPt() ? MONTHS_PT : MONTHS_EN)[d.getMonth()];
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return isPt() ? `${d.getDate()} ${month}${year}` : `${d.getDate()} ${month}${year}`;
}

export function monthName(iso: string, long = false): string {
  const d = day(iso);
  return (isPt() ? (long ? MONTHS_PT_LONG : MONTHS_PT) : (long ? MONTHS_EN_LONG : MONTHS_EN))[d.getMonth()];
}

/** Whole days from today to a date: 0 today, negative in the past. */
export function daysUntil(iso: string): number {
  const today = day(todayIso()).getTime();
  return Math.round((day(iso).getTime() - today) / 86_400_000);
}

/** "mensal · dia 15", "anual · maio", "semanal · sexta", "a cada 3 meses". */
export function repeatText(r: Pick<CollectionRoutine, "frequency" | "interval_count" | "anchor_on" | "on_miss">): string {
  const d = day(r.anchor_on);
  const n = r.interval_count || 1;
  if (r.on_miss === "from_done") return afterDoneText(r.frequency, n);
  const every: Record<RoutineFrequency, string> = {
    daily: n === 1 ? translate("daily") : translate("every {n} days", { n }),
    weekly: n === 1 ? translate("weekly") : translate("every {n} weeks", { n }),
    monthly: n === 1 ? translate("monthly") : translate("every {n} months", { n }),
    yearly: n === 1 ? translate("yearly") : translate("every {n} years", { n }),
  };
  const when: Record<RoutineFrequency, string | null> = {
    daily: null,
    weekly: (isPt() ? WEEKDAYS_PT : WEEKDAYS_EN)[d.getDay()],
    monthly: translate("day {n}", { n: d.getDate() }),
    yearly: (isPt() ? MONTHS_PT_LONG : MONTHS_EN_LONG)[d.getMonth()],
  };
  const w = when[r.frequency];
  return w ? `${every[r.frequency]} · ${w}` : every[r.frequency];
}

/** "12 meses depois da última": a from_done routine counts from completion. */
function afterDoneText(f: RoutineFrequency, n: number): string {
  if (f === "yearly") return translate("{n} months after the last", { n: 12 * n });
  if (f === "monthly") return translate(n === 1 ? "1 month after the last" : "{n} months after the last", { n });
  if (f === "weekly") return translate(n === 1 ? "1 week after the last" : "{n} weeks after the last", { n });
  return translate(n === 1 ? "1 day after the last" : "{n} days after the last", { n });
}

/** The words for "N days late". */
export function lateText(days: number): string {
  return days === 1 ? translate("1 day") : translate("{n} days", { n: days });
}

// ---------------------------------------------------------------------------
// Top bar: circle back, optional circle action, no divider — as the mockups
// ---------------------------------------------------------------------------

export function TopBar({
  onBack,
  icon = "chevron-left",
  action,
}: {
  onBack?: () => void;
  icon?: "chevron-left" | "x";
  action?: { icon: keyof typeof Feather.glyphMap; onPress: () => void; label: string };
}) {
  const router = useRouter();
  return (
    <View style={styles.top}>
      <Pressable
        onPress={onBack ?? (() => router.back())}
        style={styles.target}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={icon === "x" ? translate("Close") : translate("Back")}
      >
        <View style={styles.circle}>
          <Feather name={icon} size={19} color={colors.ink} />
        </View>
      </Pressable>
      <View style={styles.flex} />
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={styles.target}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={action.label}
        >
          <View style={styles.circle}>
            <Feather name={action.icon} size={16} color={colors.ink} />
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export function Chip({ tone, label, style }: { tone: "ok" | "late" | "soon"; label: string; style?: ViewStyle }) {
  return (
    <View style={[styles.chip, tone === "ok" ? styles.chipOk : tone === "late" ? styles.chipLate : styles.chipSoon, style]}>
      <Text style={[styles.chipText, tone === "ok" ? styles.okText : tone === "late" ? styles.lateText : styles.soonText]}>
        {label}
      </Text>
    </View>
  );
}

/** The chip for a routine's state: "✓ Pago", "2 dias", "€200 / €600", "dia 20". */
export function stateChip(r: CollectionRoutine): { tone: "ok" | "late" | "soon"; label: string } {
  if (r.state === "late") return { tone: "late", label: lateText(r.late_days) };
  if (r.state === "done") {
    const paid = r.kind === "amount" && r.current?.closed_reason === "paid";
    return { tone: "ok", label: paid ? `✓ ${translate("Paid")}` : "✓" };
  }
  if (r.current && r.kind === "amount" && Number(r.current.paid) > 0) {
    return { tone: "soon", label: `${money(r.current.paid, r.currency)} / ${money(r.current.amount, r.currency)}` };
  }
  const next = r.current?.period_on ?? r.next_on;
  if (!next) return { tone: "soon", label: "" };
  const n = daysUntil(next);
  if (n <= 0) return { tone: "soon", label: translate("today") };
  if (n < 45) return { tone: "soon", label: n === 1 ? translate("tomorrow") : translate("in {n} days", { n }) };
  const months = Math.round(n / 30);
  return { tone: "soon", label: translate("{n} months", { n: months }) };
}

// ---------------------------------------------------------------------------
// Progress bar — fills with the same easing as completing a task
// ---------------------------------------------------------------------------

export function ProgressBar({
  pct,
  late = false,
  style,
}: {
  pct: number;
  late?: boolean;
  style?: ViewStyle;
}) {
  const width = useSharedValue(0);
  useEffect(() => {
    width.value = timing(Math.max(0, Math.min(100, pct)), EXPRESSIVE);
  }, [pct, width]);
  const fill = useAnimatedStyle(() => ({ width: `${width.value}%` }));
  return (
    <View style={[styles.bar, late && styles.barLate, style]}>
      <Animated.View style={[styles.barFill, fill]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Progress ring (the room screen's 33%)
// ---------------------------------------------------------------------------

export function ProgressRing({
  pct,
  size = 132,
  stroke = 12,
  children,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = timing(Math.max(0, Math.min(1, pct / 100)), EXPRESSIVE);
  }, [pct, progress]);

  const r = (size - stroke) / 2;
  const circle = Skia.Path.Make();
  // Start at twelve o'clock, go clockwise.
  circle.addArc({ x: stroke / 2, y: stroke / 2, width: r * 2, height: r * 2 }, -90, 359.999);

  return (
    <View style={{ width: size, height: size }}>
      <Canvas style={{ width: size, height: size }}>
        <Path path={circle} style="stroke" strokeWidth={stroke} color={colors.line} />
        <Path
          path={circle}
          style="stroke"
          strokeWidth={stroke}
          strokeCap="round"
          color={colors.health}
          start={0}
          end={progress}
        />
      </Canvas>
      <View style={[StyleSheet.absoluteFill, styles.ringCentre]}>{children}</View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Typography helpers
// ---------------------------------------------------------------------------

export function Eyebrow({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.eyebrow, style]}>{children}</Text>;
}

export function MoneyText({ children, size = 30 }: { children: React.ReactNode; size?: number }) {
  return <Text style={[styles.money, { fontSize: size }]}>{children}</Text>;
}

export const kit = themed(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  body: { paddingHorizontal: 20, paddingBottom: 40 },
  title: { color: colors.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.3, marginTop: 6 },
  sub: { color: colors.inkDim, fontSize: 13, marginTop: 2 },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  cardLate: { borderColor: "#F4C7D1" },
  row: { flexDirection: "row", alignItems: "center" },
  flex: { flex: 1 },
  name: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  small: { color: colors.inkDim, fontSize: 12.5, marginTop: 2 },
  dashed: {
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: colors.faint,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
  },
  dashedText: { color: colors.inkDim, fontSize: 13.5, fontWeight: "700" },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryText: { color: colors.canvas, fontSize: 15, fontWeight: "700" },
  secondaryBtn: {
    borderColor: colors.line,
    borderWidth: 1,
    backgroundColor: colors.panel,
    borderRadius: 14,
    paddingVertical: 13,
    alignItems: "center",
  },
  secondaryText: { color: colors.ink, fontSize: 14.5, fontWeight: "700" },
  error: { color: colors.overdue, fontSize: 13, marginTop: 10 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
}));

const styles = themed(() => StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingTop: 4 },
  target: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  circle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
  },
  flex: { flex: 1 },
  chip: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, alignSelf: "flex-start" },
  chipOk: { backgroundColor: "rgba(21,128,61,0.12)" },
  chipLate: { backgroundColor: "rgba(190,18,60,0.10)" },
  chipSoon: { backgroundColor: colors.line },
  chipText: { fontSize: 11.5, fontWeight: "700" },
  okText: { color: colors.health },
  lateText: { color: colors.overdue },
  soonText: { color: colors.inkDim },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: "hidden", marginTop: 9 },
  barLate: { borderWidth: 1.5, borderColor: colors.overdue, backgroundColor: "transparent" },
  barFill: { height: "100%", borderRadius: 4, backgroundColor: colors.health },
  ringCentre: { alignItems: "center", justifyContent: "center" },
  eyebrow: {
    color: colors.inkDim,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 20,
    marginBottom: 8,
  },
  money: { color: colors.ink, fontFamily: DISPLAY, letterSpacing: -0.5 },
}));
