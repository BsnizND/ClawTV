import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

declare const __CLAWTV_BUILD_ID__: string;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const swUrl = new URL(`${import.meta.env.BASE_URL}sw.js`, window.location.origin);
    swUrl.searchParams.set("v", __CLAWTV_BUILD_ID__);
    void navigator.serviceWorker.register(swUrl.toString());
  });
}
