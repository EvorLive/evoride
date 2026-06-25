import { useEffect, useState, type MouseEvent } from "react";
import { openUrl } from "../lib/bridge";

// Render markdown safely. `marked` + `dompurify` are imported dynamically so
// they're a lazily-loaded chunk (not in the initial bundle).
export default function Markdown({ text }: { text: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ marked }, dompurify] = await Promise.all([
        import("marked"),
        import("dompurify"),
      ]);
      const raw = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
      const clean = dompurify.default.sanitize(raw);
      if (alive) setHtml(clean);
    })();
    return () => {
      alive = false;
    };
  }, [text]);

  // A link in rendered markdown (which can come from AI output, repo files, or a
  // Jira description) must NEVER navigate the app's own webview — that would
  // replace the IDE or enable phishing. Intercept every click: open http(s)
  // links in the OS browser via the opener plugin, and ignore anything else.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) void openUrl(href);
  };

  return (
    <div className="md-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
