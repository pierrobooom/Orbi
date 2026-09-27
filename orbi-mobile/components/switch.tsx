// The app's on/off switch: React Native's Switch with an OFF state you can
// actually see.
//
// Every switch passed colors.line as its off colour — the same pale grey as
// a hairline — and none set ios_backgroundColor, which is what iOS shows
// behind a switch that is off. On a white card the result was a white knob
// on an almost-white track: easy to miss that there was a control at all.
// The off track is now colors.faint, a clearly visible grey in Day and Night.
//
// Use it exactly like Switch. The ON colour can still be chosen per switch
// (trackColor.true); the OFF colour is deliberately not overridable, so the
// problem cannot come back one screen at a time.

import React from "react";
import { Switch as RNSwitch, type SwitchProps } from "react-native";

import { colors } from "@/theme/colors";

export function Switch({ trackColor, ...props }: SwitchProps) {
  return (
    <RNSwitch
      {...props}
      trackColor={{ false: colors.faint, true: trackColor?.true ?? colors.accent }}
      ios_backgroundColor={colors.faint}
    />
  );
}
