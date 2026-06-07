import { useEffect, useState } from "react";

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

  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
