// A date field that looks like the other fields: on iOS the compact native
// picker (a pill that opens its own calendar), on Android a field that opens
// the system dialog. Follows Day/Night so the pill is legible in both.

import DateTimePicker from "@react-native-community/datetimepicker";
import React, { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { day, shortDate } from "@/components/collection/kit";
import { colors, pickerTheme } from "@/theme/colors";
import { themed } from "@/theme/themed";

function iso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function DateField({ value, onChange, placeholder }: {
  value: string | null;
  onChange: (iso: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const date = value ? day(value) : new Date();

  if (Platform.OS === "ios") {
    return (
      <View style={styles.field}>
        <DateTimePicker
          value={date}
          mode="date"
          display="compact"
          themeVariant={pickerTheme()}
          onChange={(_e, d) => { if (d) onChange(iso(d)); }}
          style={styles.ios}
        />
      </View>
    );
  }
  return (
    <>
      <Pressable style={styles.field} onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={value ? styles.text : styles.placeholder}>
          {value ? shortDate(value) : placeholder ?? ""}
        </Text>
      </Pressable>
      {open ? (
        <DateTimePicker
          value={date}
          mode="date"
          display="default"
          onChange={(e, d) => {
            setOpen(false);
            if (e.type === "set" && d) onChange(iso(d));
          }}
        />
      ) : null}
    </>
  );
}

const styles = themed(() => StyleSheet.create({
  field: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 46,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  ios: { marginLeft: -8 },
  text: { color: colors.ink, fontSize: 15 },
  placeholder: { color: colors.inkDim, fontSize: 15 },
}));
