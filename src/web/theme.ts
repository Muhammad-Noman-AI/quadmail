// Light / dark / follow-the-system theme. Tailwind's `dark:` variant follows the `dark` class on <html>.
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "qm:theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function themeChoice(): ThemeChoice {
  const value = localStorage.getItem(KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function applyTheme(choice: ThemeChoice = themeChoice()): void {
  const dark = choice === "dark" || (choice === "system" && media().matches);
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0a0a0a" : "#ffffff");
}

export function setThemeChoice(choice: ThemeChoice): void {
  if (choice === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  applyTheme(choice);
  window.dispatchEvent(new Event("qm:theme"));
}

/** Call once at startup: applies the stored choice and follows system changes while on "system". */
export function initTheme(): void {
  applyTheme();
  media().addEventListener("change", () => applyTheme());
}
