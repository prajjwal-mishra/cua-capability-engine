/**
 * The in-page perception pass. This function is serialized into the browser and
 * runs once per frame, so it must be entirely self-contained — no imports, no
 * closure over module scope.
 *
 * Why compute the accessibility view ourselves rather than read Chromium's AX
 * tree over CDP: the AX tree gives us computed names keyed by backendDOMNodeId,
 * but we need a live element handle paired with each name so Playwright can
 * dispatch real, actionability-checked input against it. Bridging AX node ids
 * back to handles means either mutating the page (stamping attributes) or
 * clicking by coordinate — and clicking by coordinate is the exact thing this
 * design rejects. So we implement the subset of the accname algorithm these
 * controls actually exercise and keep the handle alongside it.
 *
 * The important property is that the OUTPUT SHAPE is platform-neutral. On a
 * desktop surface, UIA/AXAPI compute role and name for us and this whole file
 * collapses to a tree walk — which is why `nativeAccessibilityNames` is on the
 * capabilities record.
 */

export interface RawElement {
  ref: string;
  role: string;
  name: string;
  nameSource: string;
  value?: string;
  state: { disabled?: boolean; checked?: boolean; readOnly?: boolean; required?: boolean };
  bounds?: { x: number; y: number; width: number; height: number };
  nearbyText: {
    leftCell?: string;
    aboveCell?: string;
    precedingText?: string;
    columnHeader?: string;
    rowKey?: string;
  };
  structuralPath: string;
  tag: string;
}

/**
 * Collect the interactable and readable elements of one frame.
 * `refPrefix` namespaces refs per frame so they stay unique across the page.
 */
export function collectElements(refPrefix: string, maxElements: number): RawElement[] {
  const out: RawElement[] = [];
  const handles: Element[] = [];

  const txt = (n: Node | null | undefined): string => {
    if (!n) return "";
    return (n.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  };

  /**
   * A cell's own text, ignoring text that belongs to controls inside it.
   *
   * Legacy pages routinely put a message and a link in the same cell:
   *   <td>No member records match. <a>New Search</a></td>
   * Dropping such cells entirely (because they contain a control) loses exactly
   * the sentences that identify business outcomes, while taking their full
   * textContent would duplicate every link label as cell text.
   */
  const ownText = (el: Element): string => {
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll("a, button, input, select, textarea, table").forEach((n) => n.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  };

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  /* --------------------------------------------------------------- role -- */

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "hidden") return "generic";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "button") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "th") return "columnheader";
    if (tag === "td") return "cell";
    if (tag === "tr") return "row";
    if (tag === "table") return "table";
    return "generic";
  };

  /* ------------------------------------------------- accessible name ----- */

  const accessibleName = (el: Element, role: string): { name: string; source: string } => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => txt(el.ownerDocument.getElementById(id)))
        .filter(Boolean);
      if (parts.length > 0) return { name: parts.join(" "), source: "aria-labelledby" };
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return { name: ariaLabel.trim(), source: "aria-label" };

    const tag = el.tagName.toLowerCase();

    // <input type=button|submit> takes its name from `value`.
    if (tag === "input" && role === "button") {
      const v = (el as HTMLInputElement).value;
      if (v && v.trim()) return { name: v.trim(), source: "value" };
    }

    if (tag === "input" || tag === "select" || tag === "textarea") {
      const id = el.getAttribute("id");
      if (id) {
        const esc = (window as unknown as { CSS?: { escape(s: string): string } }).CSS?.escape;
        const sel = esc ? `label[for="${esc(id)}"]` : `label[for="${id}"]`;
        const lbl = el.ownerDocument.querySelector(sel);
        if (lbl && txt(lbl)) return { name: txt(lbl), source: "label-element" };
      }
      const wrapping = el.closest("label");
      if (wrapping && txt(wrapping)) return { name: txt(wrapping), source: "label-element" };
    }

    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) return { name: alt.trim(), source: "alt" };
    }

    if (role === "button" || role === "link" || role === "heading" || role === "columnheader") {
      const t = txt(el);
      if (t) return { name: t, source: "text-content" };
    }

    if (role === "cell") {
      const t = ownText(el);
      if (t) return { name: t, source: "text-content" };
    }

    const title = el.getAttribute("title");
    if (title && title.trim()) return { name: title.trim(), source: "title" };

    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return { name: ph.trim(), source: "placeholder" };

    return { name: "", source: "none" };
  };

  /* ------------------------------------------------- positional context -- */

  const nearby = (el: Element) => {
    const res: RawElement["nearbyText"] = {};

    const cell = el.closest("td, th");
    const row = el.closest("tr");
    const table = el.closest("table");

    if (cell && row) {
      const cells = Array.from(row.children).filter(
        (c) => c.tagName === "TD" || c.tagName === "TH",
      );
      const idx = cells.indexOf(cell);

      if (idx > 0) {
        const left = txt(cells[idx - 1]);
        if (left) res.leftCell = left;
      }
      // A header row has no row key; only data rows do.
      const inHeaderRow = cell.tagName === "TH";
      const firstCellText = txt(cells[0]);
      if (!inHeaderRow && firstCellText && cells[0] !== cell) res.rowKey = firstCellText;

      if (table) {
        const rows = Array.from(table.rows);
        const rIdx = rows.indexOf(row as HTMLTableRowElement);

        if (rIdx > 0) {
          const above = rows[rIdx - 1]?.cells[idx];
          const aboveText = txt(above);
          if (aboveText) res.aboveCell = aboveText;
        }
        // Column header: the th at this index in the table's first row.
        const headerRow = rows[0];
        if (headerRow && rIdx > 0) {
          const th = headerRow.cells[idx];
          if (th && th.tagName === "TH") {
            const h = txt(th);
            if (h) res.columnHeader = h;
          }
        }
      }
    }

    // Text node immediately preceding the element inside its parent.
    let prev = el.previousSibling;
    while (prev && prev.nodeType !== Node.TEXT_NODE && prev.nodeType !== Node.ELEMENT_NODE) {
      prev = prev.previousSibling;
    }
    if (prev) {
      const t = txt(prev);
      if (t) res.precedingText = t;
    }

    return res;
  };

  /* ------------------------------------------------- structural path ----- */

  const structuralPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === Node.ELEMENT_NODE && depth < 12) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const idx = same.indexOf(node) + 1;
      parts.unshift(`${node.tagName}[${idx}]`);
      node = parent;
      depth++;
    }
    return parts.join("/");
  };

  /* ------------------------------------------------------------- walk ---- */

  const SELECTOR =
    "input, textarea, select, button, a[href], th, td, h1, h2, h3, h4, h5, h6, [role]";
  const candidates = Array.from(document.querySelectorAll(SELECTOR));

  for (const el of candidates) {
    if (out.length >= maxElements) break;
    const role = roleOf(el);
    if (role === "generic") continue;
    if (!visible(el)) continue;

    // A cell earns its place by carrying text of its own. Skipping every cell
    // that contains a control or a nested table looks tidier but silently drops
    // the sentences that identify exceptional states — a session-timeout notice
    // sits in the same cell as the re-auth form, and a "no records" message in
    // the same cell as the link back. ownText() already excludes anything that
    // belongs to a descendant control or table, so an outer wrapper contributes
    // only what it actually says.
    if (role === "cell" || role === "columnheader") {
      if (!ownText(el)) continue;
    }

    let { name, source } = accessibleName(el, role);
    const nb = nearby(el);

    // Legacy heuristic pass: the a11y tree gives an unnamed control, so fall
    // back to the layout. In these apps the label IS the adjacent table cell.
    if (
      !name &&
      (role === "textbox" || role === "combobox" || role === "checkbox" || role === "radio")
    ) {
      if (nb.leftCell) {
        name = nb.leftCell;
        source = "heuristic-table-cell";
      } else if (nb.aboveCell) {
        name = nb.aboveCell;
        source = "heuristic-table-cell";
      } else if (nb.precedingText) {
        name = nb.precedingText;
        source = "heuristic-preceding-text";
      }
    }

    const r = el.getBoundingClientRect();
    const anyEl = el as HTMLInputElement & HTMLSelectElement;

    const raw: RawElement = {
      ref: `${refPrefix}${out.length + 1}`,
      role,
      name: name.replace(/\s+/g, " ").trim(),
      nameSource: source,
      state: {},
      bounds: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      nearbyText: nb,
      structuralPath: structuralPath(el),
      tag:
        el.tagName.toLowerCase() + (el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""),
    };

    if (role === "textbox" || role === "combobox") raw.value = anyEl.value ?? undefined;
    if (anyEl.disabled) raw.state.disabled = true;
    if (anyEl.required) raw.state.required = true;
    if (anyEl.readOnly) raw.state.readOnly = true;
    if (role === "checkbox" || role === "radio") raw.state.checked = anyEl.checked;

    out.push(raw);
    handles.push(el);
  }

  // Park the handles so `act` can resolve a ref back to a live element without
  // re-querying, and without the ref ever leaving this frame.
  (window as unknown as { __cuaRefs?: Element[]; __cuaRefIds?: string[] }).__cuaRefs = handles;
  (window as unknown as { __cuaRefIds?: string[] }).__cuaRefIds = out.map((o) => o.ref);

  return out;
}
