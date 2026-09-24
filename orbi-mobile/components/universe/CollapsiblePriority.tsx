// The "Needs you first" card, and the edge tab it tucks into.
//
// The card is useful and also permanent, and a permanent panel on the main
// screen becomes furniture: after a week it is either ignored or resented.
// So it can be put away — swiped to the right edge, or sent there with its
// chevron — where it waits as a small tab you can pull back out, the same
// way the system edge panels on a phone work.
//
// HIDING NEVER HIDES THAT SOMETHING IS LATE
// While the task is overdue the tab carries a red dot. Putting the card away
// is a choice about screen space; it must not become a way of not knowing.
//
// Hidden stays hidden across restarts, per device. It is a preference about
// how this screen looks, like handedness, not about any particular task —
// so a different task becoming the priority does not reopen it.

import AsyncStorage from "@react-native-async-storage/async-storage";
import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { useT } from "@/i18n";
import type { ServerTask } from "@/services/api";
import { cue } from "@/services/feedback";
import { colors } from "@/theme/colors";
import { themed } from "@/theme/themed";
import { STANDARD, timing } from "@/theme/motion";
import { PriorityCard } from "./PriorityCard";

const HIDDEN_KEY = "orbi.priority.hidden";

// How far a swipe has to travel, as a share of the card, before letting go
// puts it away rather than springing it back. A third: far enough that a
// scroll that wandered sideways does not dismiss it, short enough that a
// deliberate flick always does.
const DISMISS_SHARE = 0.33;
// ...or how fast. A quick flick should count even if it was short.
const DISMISS_VELOCITY = 650;

interface Props {
  task: ServerTask;
  clusterName: string | null;
  now: Date;
  onOpen: () => void;
}

export function CollapsiblePriority({ task, clusterName, now, onOpen }: Props) {
  const t = useT();
  const { width } = useWindowDimensions();
  // Undefined until storage answers, so the card never flashes open and
  // then shuts on a device where the user hid it.
  const [hidden, setHidden] = useState<boolean | undefined>(undefined);
  const x = useSharedValue(0);

  useEffect(() => {
    AsyncStorage.getItem(HIDDEN_KEY)
      .then((value) => setHidden(value === "1"))
      .catch(() => setHidden(false));
  }, []);

  const remember = (value: boolean) => {
    setHidden(value);
    AsyncStorage.setItem(HIDDEN_KEY, value ? "1" : "0").catch(() => {});
  };

  const hide = () => {
    cue("tap");
    // Slide out first and only then unmount, so it visibly goes to the edge
    // it will be found at rather than simply vanishing.
    x.value = timing(width, STANDARD);
    setTimeout(() => remember(true), STANDARD);
  };

  const show = () => {
    cue("tap");
    x.value = width;
    remember(false);
    x.value = timing(0, STANDARD);
  };

  const late = Boolean(task.due_at && new Date(task.due_at) < now);

  // Rightward only, and only once clearly horizontal. failOffsetY hands a
  // vertical drag straight back to whatever is underneath, and the card's own
  // tap still works because the pan needs 12px of travel to start.
  const swipe = Gesture.Pan()
    .activeOffsetX(12)
    .failOffsetY([-12, 12])
    .onUpdate((e) => {
      "worklet";
      x.value = Math.max(0, e.translationX);
    })
    .onEnd((e) => {
      "worklet";
      if (e.translationX > width * DISMISS_SHARE || e.velocityX > DISMISS_VELOCITY) {
        runOnJS(hide)();
      } else {
        x.value = timing(0, STANDARD);
      }
    });

  // The tab can be pulled out as well as tapped — the gesture a phone's own
  // edge panels teach.
  const pull = Gesture.Pan()
    .activeOffsetX(-10)
    .onEnd((e) => {
      "worklet";
      if (e.translationX < -20) runOnJS(show)();
    });

  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    opacity: 1 - Math.min(x.value / width, 1) * 0.6,
  }));

  if (hidden === undefined) return null;

  if (hidden) {
    return (
      <GestureDetector gesture={pull}>
        <View style={styles.tabRow} pointerEvents="box-none">
          <Pressable
            onPress={show}
            style={styles.tab}
            hitSlop={{ top: 8, bottom: 8, left: 12 }}
            accessibilityRole="button"
            accessibilityLabel={
              late
                ? `${t("Show what needs you first")} — ${t("Late today")}`
                : t("Show what needs you first")
            }
          >
            <Feather name="chevron-left" size={20} color={colors.ink} />
            {late ? <View style={styles.dot} /> : null}
          </Pressable>
        </View>
      </GestureDetector>
    );
  }

  return (
    <GestureDetector gesture={swipe}>
      <Animated.View style={[styles.cardWrap, slide]}>
        <PriorityCard
          task={task}
          clusterName={clusterName}
          onPress={onOpen}
          now={now}
          onHide={hide}
        />
      </Animated.View>
    </GestureDetector>
  );
}

const styles = themed(() => StyleSheet.create({
  cardWrap: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 },
  // A row the width of the screen so the tab can sit flush on the right edge.
  tabRow: { alignItems: "flex-end", paddingBottom: 6 },
  // Flush with the edge, rounded only on the side facing in, like a
  // handle attached to the frame of the phone.
  tab: {
    width: 30,
    height: 58,
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
    borderWidth: 1,
    borderRightWidth: 0,
    borderColor: colors.line,
    backgroundColor: colors.panel,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#14161C",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: -1, height: 1 },
    elevation: 2,
  },
  dot: {
    position: "absolute",
    top: 7,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.overdue,
    borderWidth: 1.5,
    borderColor: colors.panel,
  },
}));
