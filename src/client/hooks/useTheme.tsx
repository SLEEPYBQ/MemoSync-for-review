

import { createContext, useContext, useEffect, type ReactNode } from "react"

export type ThemePreference = "light"

interface ThemeContextValue {
  theme: ThemePreference
  resolvedTheme: "light"
  setTheme: (theme: ThemePreference) => void
}

const LOCKED_LIGHT: ThemeContextValue = {
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => {},
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.classList.remove("dark")
    document.documentElement.style.colorScheme = "light"
  }, [])

  return <ThemeContext.Provider value={LOCKED_LIGHT}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}
