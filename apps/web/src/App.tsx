import { useEffect } from "react";

import { BrowseApp } from "./BrowseApp";
import { ReceiverApp } from "./ReceiverApp";

type AppearanceMode = "dark" | "light";

export function App() {
  const url = new URL(window.location.href);
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  const isReceiverMode = url.searchParams.get("mode") === "receiver"
    || normalizedPath.endsWith("/receiver");
  const appearance = resolveInitialAppearance(url);

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    document.documentElement.style.colorScheme = appearance;

    const themeColor = appearance === "light" ? "#ffffff" : "#000000";
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) {
      themeColorMeta.setAttribute("content", themeColor);
    }
  }, [appearance]);

  if (isReceiverMode) {
    return <ReceiverApp />;
  }

  return <BrowseApp />;
}

function resolveInitialAppearance(url: URL): AppearanceMode {
  const requestedAppearance = parseAppearance(url.searchParams.get("appearance"));
  if (requestedAppearance) {
    return requestedAppearance;
  }

  return "light";
}

function parseAppearance(value: string | null): AppearanceMode | null {
  return value === "dark" || value === "light" ? value : null;
}
