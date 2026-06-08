import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TerminalWindow from "./TerminalWindow";

// A popped-out terminal window loads index.html#term=<agentId> — render just it.
const termMatch = window.location.hash.match(/^#term=(.+)$/);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {termMatch ? <TerminalWindow id={decodeURIComponent(termMatch[1])} /> : <App />}
  </React.StrictMode>,
);
