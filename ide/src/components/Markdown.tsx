import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Render markdown safely (sanitized) for the editor preview and intent doc.
export default function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [text]);

  return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
