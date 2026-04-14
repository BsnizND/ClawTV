import { BrowseApp } from "./BrowseApp";
import { ReceiverApp } from "./ReceiverApp";

export function App() {
  const url = new URL(window.location.href);
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  const isReceiverMode = url.searchParams.get("mode") === "receiver"
    || normalizedPath.endsWith("/receiver");

  if (isReceiverMode) {
    return <ReceiverApp />;
  }

  return <BrowseApp />;
}
