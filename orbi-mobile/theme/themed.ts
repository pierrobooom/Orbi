// Stylesheets that follow the palette.
//
//   const styles = themed(() => StyleSheet.create({ ... }));
//
// The body is exactly what it was: it still reads `colors.x`. The wrapper
// defers running it until something reads a style, and runs it again the
// first time a style is read after the palette has changed. `styles.card`
// therefore always holds the current theme's values, and no screen had to
// be rewritten to take a theme argument.
//
// A Proxy rather than a hook so the call sites stay `styles.card` — module
// scope, typed exactly as StyleSheet.create types it, usable from helper
// components and render callbacks that could never call a hook. The cost is
// one version comparison per style read, which is nothing next to a render.
//
// This does not make anything RE-RENDER. It only guarantees that a render
// gets current values. Re-rendering on a theme change is the navigators' job
// (screenLayout in app/_layout.tsx).

import { paletteVersion } from "./colors";

export function themed<T extends object>(build: () => T): T {
  let built: T | null = null;
  let builtAt = -1;

  const current = (): T => {
    const version = paletteVersion();
    if (built === null || builtAt !== version) {
      built = build();
      builtAt = version;
    }
    return built;
  };

  return new Proxy({} as T, {
    get: (_target, key) => (current() as Record<PropertyKey, unknown>)[key],
    has: (_target, key) => key in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(current(), key);
      // A Proxy may only report a property as configurable if the target
      // agrees, and the empty target knows none of these keys.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
