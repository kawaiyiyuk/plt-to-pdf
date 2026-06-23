const ALLOWED_ELEMENTS = new Set([
  "circle",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "tspan"
]);

const BLOCKED_ELEMENTS = new Set([
  "foreignobject",
  "iframe",
  "image",
  "script",
  "style",
  "use"
]);

const ALLOWED_ATTRIBUTES = new Set([
  "class",
  "clip-rule",
  "cx",
  "cy",
  "d",
  "dominant-baseline",
  "fill",
  "fill-rule",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "points",
  "r",
  "rx",
  "ry",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-width",
  "style",
  "text-anchor",
  "transform",
  "width",
  "x",
  "x1",
  "x2",
  "y",
  "y1",
  "y2"
]);

const ALLOWED_STYLE_PROPERTIES = new Set([
  "fill",
  "fill-rule",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-width"
]);

export function sanitizeSvgInnerMarkup(svg) {
  const inner = extractSvgInnerMarkup(svg);
  const output = [];
  const openElements = [];
  let blockedDepth = 0;

  for (const token of inner.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("<!--")) {
      continue;
    }

    if (token.startsWith("<![CDATA[")) {
      if (blockedDepth === 0) {
        output.push(escapeHtml(token.slice(9, -3)));
      }
      continue;
    }

    if (!token.startsWith("<")) {
      if (blockedDepth === 0) {
        output.push(escapeHtml(token));
      }
      continue;
    }

    const closing = /^<\s*\//.test(token);
    const nameMatch = token.match(/^<\s*\/?\s*([A-Za-z][\w:.-]*)/);
    const rawName = nameMatch?.[1]?.toLowerCase();
    const name = rawName === "foreignobject" ? rawName : rawName?.replace(/^svg:/, "");
    if (!name) {
      continue;
    }

    if (BLOCKED_ELEMENTS.has(name)) {
      if (!closing && !isSelfClosingTag(token)) {
        blockedDepth += 1;
      } else if (closing && blockedDepth > 0) {
        blockedDepth -= 1;
      }
      continue;
    }

    if (blockedDepth > 0 || !ALLOWED_ELEMENTS.has(name)) {
      continue;
    }

    if (closing) {
      const lastIndex = openElements.lastIndexOf(name);
      if (lastIndex === -1) {
        continue;
      }
      for (let i = openElements.length - 1; i >= lastIndex; i -= 1) {
        output.push(`</${openElements.pop()}>`);
      }
      continue;
    }

    const attrs = sanitizeAttributes(token);
    const selfClosing = isSelfClosingTag(token);
    output.push(`<${name}${attrs}${selfClosing ? " />" : ">"}`);
    if (!selfClosing) {
      openElements.push(name);
    }
  }

  while (openElements.length > 0) {
    output.push(`</${openElements.pop()}>`);
  }

  return output.join("");
}

function extractSvgInnerMarkup(svg) {
  const match = String(svg ?? "").match(/<svg\b[^>]*>([\s\S]*?)<\/svg\s*>/i);
  return match ? match[1] : String(svg ?? "");
}

function sanitizeAttributes(tag) {
  const attrs = [];
  const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = attrPattern.exec(tag))) {
    const rawName = match[1].toLowerCase();
    const name = rawName.replace(/^svg:/, "");
    if (name.startsWith("on") || name.includes(":") || !ALLOWED_ATTRIBUTES.has(name)) {
      continue;
    }

    const rawValue = match[3] ?? match[4] ?? match[5] ?? "";
    const value = name === "style" ? sanitizeStyle(rawValue) : rawValue.trim();
    if (!value || hasDangerousValue(value)) {
      continue;
    }
    attrs.push(`${name}="${escapeAttribute(value)}"`);
  }
  return attrs.length ? ` ${attrs.join(" ")}` : "";
}

function sanitizeStyle(styleText) {
  const declarations = [];
  for (const item of styleText.split(";")) {
    const separator = item.indexOf(":");
    if (separator === -1) continue;
    const name = item.slice(0, separator).trim().toLowerCase();
    const value = item.slice(separator + 1).trim();
    if (!ALLOWED_STYLE_PROPERTIES.has(name) || !value || hasDangerousValue(value)) {
      continue;
    }
    declarations.push(`${name}:${value}`);
  }
  return declarations.join("; ");
}

function hasDangerousValue(value) {
  return /(?:javascript:|data:|vbscript:|url\s*\(|expression\s*\()/i.test(value);
}

function isSelfClosingTag(tag) {
  return /\/\s*>$/.test(tag);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
