import React from "react";

// Root error boundary: a render error or a failed lazy-chunk load anywhere in
// the tree otherwise unmounts the WHOLE app — a silent blank window with no
// hint of what happened. Catch it, say what broke, and offer a reload (which
// re-fetches lazy chunks — the usual cure after the bundle changed underneath
// a running webview).
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Evor crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          fontFamily: "system-ui, sans-serif",
          background: "#0b0d12",
          color: "#e6e8ee",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 18, margin: 0 }}>Evor hit an error</h1>
        <p style={{ margin: 0, opacity: 0.8, maxWidth: 560, fontSize: 13 }}>
          {String(error.message || error)}
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8,
            padding: "8px 18px",
            borderRadius: 6,
            border: "1px solid #334155",
            background: "#1c7ed6",
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
