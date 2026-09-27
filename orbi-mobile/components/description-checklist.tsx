// A task description with its checklist lines drawn as tappable boxes.
//
// Plain lines render as text; "- [ ] item" lines render as rows you can
// tick in place, without entering edit mode — the Kanboard behaviour: the
// description stays text, but the list inside it is live.

import Feather from "@expo/vector-icons/Feather";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { parseChecklist } from "@/services/checklist";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";

interface Props {
  description: string;
  onToggle: (line: number) => void;
}

export function DescriptionChecklist({ description, onToggle }: Props) {
  const blocks = parseChecklist(description);
  return (
    <View style={styles.wrap}>
      {blocks.map((block) =>
        block.kind === "text" ? (
          <Text key={`t-${block.text}`} style={styles.text}>
            {block.text}
          </Text>
        ) : (
          <Pressable
            key={`i-${block.line}`}
            onPress={() => onToggle(block.line)}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: block.checked }}
            accessibilityLabel={block.text}
          >
            <View style={[styles.box, block.checked && styles.boxChecked]}>
              {block.checked ? (
                <Feather name="check" size={14} color={colors.canvas} />
              ) : null}
            </View>
            <Text style={[styles.itemText, block.checked && styles.itemDone]}>
              {block.text}
            </Text>
          </Pressable>
        ),
      )}
    </View>
  );
}

const styles = themed(() => StyleSheet.create({
  wrap: { gap: 2 },
  text: { color: colors.ink, fontSize: 14, lineHeight: 20, marginVertical: 4 },
  // A full-width row, so the whole line is the target and not just the box.
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  pressed: { opacity: 0.6 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.inkDim,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  itemText: { flex: 1, color: colors.ink, fontSize: 14, lineHeight: 20 },
  // Struck through and faded, but still readable: a ticked item is often
  // re-read ("did I already get the eggs?").
  itemDone: { color: colors.inkDim, textDecorationLine: "line-through" },
}));
