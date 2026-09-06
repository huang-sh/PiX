import { themeColors, type ThemeId } from "../../../shared/theme";

const ansiColors = {
  light: {
    black: "#202124",
    red: "#b3261e",
    green: "#146c2e",
    yellow: "#6b5700",
    blue: "#0b57d0",
    magenta: "#7b1fa2",
    cyan: "#00696f",
    white: "#5f6368",
    brightBlack: "#5f6368",
    brightRed: "#b3261e",
    brightGreen: "#188038",
    brightYellow: "#806000",
    brightBlue: "#1a73e8",
    brightMagenta: "#8e24aa",
    brightCyan: "#007b83",
    brightWhite: "#202124",
  },
  dark: {
    black: "#1b2433", red: "#ed8796", green: "#a6da95", yellow: "#eed49f",
    blue: "#8aadf4", magenta: "#c6a0f6", cyan: "#8bd5ca", white: "#cad3f5",
    brightBlack: "#808b9f", brightRed: "#f5a9b5", brightGreen: "#b9e4ac", brightYellow: "#f4dfb1",
    brightBlue: "#adc4f7", brightMagenta: "#d6bbf9", brightCyan: "#a7e2da", brightWhite: "#edf6f2",
  },
};

export function terminalTheme(theme: ThemeId) {
  const colors = themeColors[theme];
  return {
    ...ansiColors[theme === "dark" ? "dark" : "light"],
    background: colors.surface, foreground: colors.text, cursor: colors.text,
    selectionBackground: colors["accent-soft"],
  };
}
