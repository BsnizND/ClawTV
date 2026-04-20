import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void disableServiceWorkerCaching();
  });
}

async function disableServiceWorkerCaching() {
  const registrations = await navigator.serviceWorker.getRegistrations();

  await Promise.all(registrations.map(async (registration) => {
    try {
      await registration.update();
    } catch {
      // Keep going so one broken registration cannot block the cleanup sweep.
    }
  }));

  await Promise.all(registrations.map((registration) => registration.unregister()));

  if ("caches" in window) {
    const cacheKeys = await window.caches.keys();
    await Promise.all(cacheKeys.map((key) => window.caches.delete(key)));
  }
}
