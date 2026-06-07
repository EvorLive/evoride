// Relay endpoints. Override via NEXT_PUBLIC_RELAY_* for non-local deployments.

export const RELAY_HTTP =
  process.env.NEXT_PUBLIC_RELAY_HTTP ?? "http://127.0.0.1:8787";

export const RELAY_WS =
  process.env.NEXT_PUBLIC_RELAY_WS ?? "ws://127.0.0.1:8787";

export const viewUrl = (id: string) => `${RELAY_WS}/view/${id}`;
export const controlUrl = (id: string, token: string) =>
  `${RELAY_WS}/control/${id}?token=${encodeURIComponent(token)}`;
export const sessionsUrl = () => `${RELAY_HTTP}/sessions`;
