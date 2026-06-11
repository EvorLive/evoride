import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TerminalWindow from "./TerminalWindow";
import ErrorBoundary from "./components/ErrorBoundary";
// VSCode's icon font (folder/file/chevron glyphs) used across the explorer + toolbar.
import "@vscode/codicons/dist/codicon.css";

// A popped-out terminal window loads index.html#term=<agentId> — render just it.
const termMatch = window.location.hash.match(/^#term=(.+)$/);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {termMatch ? <TerminalWindow id={decodeURIComponent(termMatch[1])} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
