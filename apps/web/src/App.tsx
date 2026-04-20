import { useEffect, useState } from "react";

import { BrowseApp } from "./BrowseApp";
import { ReceiverApp } from "./ReceiverApp";

type AppearanceMode = "dark" | "light";

const APPEARANCE_STORAGE_KEY = "clawtv-appearance-mode";

export function App() {
  const url = new URL(window.location.href);
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  const isReceiverMode = url.searchParams.get("mode") === "receiver"
    || normalizedPath.endsWith("/receiver");
  const [appearance, setAppearance] = useState<AppearanceMode>(() => resolveInitialAppearance(url));

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    document.documentElement.style.colorScheme = appearance;

    const themeColor = appearance === "light" ? "#ffffff" : "#000000";
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", themeColor);
    }

    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
    } catch {
      // Ignore storage failures and keep the in-memory setting.
    }
  }, [appearance]);

  if (isReceiverMode) {
    return <ReceiverApp />;
  }

  return (
    <BrowseApp
      appearance={appearance}
      onToggleAppearance={() => setAppearance((current) => current === "dark" ? "light" : "dark")}
    />
  );
}

function resolveInitialAppearance(url: URL): AppearanceMode {
  const requestedAppearance = parseAppearance(url.searchParams.get("appearance"));
  if (requestedAppearance) {
    return requestedAppearance;
  }

  try {
    const storedAppearance = parseAppearance(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
    return storedAppearance ?? "dark";
  } catch {
    return "dark";
  }
}

function parseAppearance(value: string | null): AppearanceMode | null {
  return value === "dark" || value === "light" ? value : null;
}
