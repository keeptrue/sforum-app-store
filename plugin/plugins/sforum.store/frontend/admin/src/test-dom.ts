// Minimal DOM used by the Bun tests and the /tmp render harness.
//
// The repository has no happy-dom/jsdom dependency and the page must not add one,
// so this shim implements exactly the surface `catalog.ts` touches: element creation,
// class list, attributes/dataset, text, append/replace/remove, listeners with
// bubbling, plus a tiny serializer for harness output. It is NOT a browser: layout,
// CSS, focus and disabled-click semantics are not modelled.

export type ShimEvent = {
  type: string;
  target?: unknown;
  currentTarget?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  key?: string;
};

class BaseNode {
  readonly nodeType: number;
  parentNode: ShimElement | null = null;
  childNodes: BaseNode[] = [];
  listeners = new Map<string, Set<(event: any) => void>>();

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  get children(): ShimElement[] {
    return this.childNodes.filter((node): node is ShimElement => node.nodeType === 1);
  }

  get textContent(): string {
    if (this.nodeType === 3) return String((this as unknown as ShimText).nodeValue ?? "");
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    if (this.nodeType === 3) {
      (this as unknown as ShimText).nodeValue = String(value ?? "");
      return;
    }
    this.clearRawHTML();
    this.childNodes = [];
    const text = String(value ?? "");
    if (text) this.appendChild(createText(text));
  }

  /** `innerHTML` lives on elements; text nodes have nothing to clear. */
  clearRawHTML(): void {
    if (this.nodeType === 1) (this as unknown as ShimElement).rawHTML = "";
  }

  append(...items: unknown[]): void {
    for (const item of items) this.appendChild(item);
  }

  appendChild(item: unknown): unknown {
    const node = typeof item === "string" ? createText(item) : (item as BaseNode | null);
    if (!node) return node;
    if (node.parentNode) node.remove();
    node.parentNode = this as unknown as ShimElement;
    this.childNodes.push(node);
    return node;
  }

  replaceChildren(...items: unknown[]): void {
    this.clearRawHTML();
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...items);
  }

  remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    parent.childNodes = parent.childNodes.filter((node) => (node as unknown) !== this);
    this.parentNode = null;
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: (event: any) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  /** Bubbles like the real DOM, so delegated handlers can be exercised. */
  dispatchEvent(event: ShimEvent): boolean {
    const prepared: any = {
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    };
    prepared.target = prepared.target ?? this;
    let current: any = this;
    while (current) {
      prepared.currentTarget = current;
      const set: Set<(event: any) => void> | undefined = current.listeners?.get(prepared.type);
      if (set) for (const handler of Array.from(set)) handler(prepared);
      current = current.parentNode;
    }
    return true;
  }
}

export class ShimText extends BaseNode {
  nodeValue: string;

  constructor(value: string) {
    super(3);
    this.nodeValue = value;
  }
}

function createText(value: string): ShimText {
  return new ShimText(value);
}

export class ShimElement extends BaseNode {
  tagName: string;
  attributes: Record<string, string> = {};
  classes: string[] = [];
  style: Record<string, string> = {};
  /**
   * Markup assigned through `innerHTML`. The shim does not parse HTML: it stores the
   * string verbatim and `toHTML` emits it as-is, which is enough to assert that a
   * server-rendered README reached the container. Nodes inside it are invisible to
   * `querySelector*`; assert on `toHTML` / `innerHTML` instead.
   */
  rawHTML = "";
  value = "";
  checked = false;
  hidden = false;
  disabled = false;
  readOnly = false;
  selected = false;

  constructor(tagName: string) {
    super(1);
    this.tagName = tagName.toUpperCase();
  }

  get innerHTML(): string {
    return this.rawHTML;
  }

  set innerHTML(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.rawHTML = String(value ?? "");
  }

  get className(): string {
    return this.classes.join(" ");
  }

  set className(value: string) {
    this.classes = String(value ?? "").split(/\s+/).filter(Boolean);
  }

  get id(): string {
    return this.attributes.id ?? "";
  }

  set id(value: string) {
    this.attributes.id = String(value);
  }

  get classList() {
    const self = this;
    return {
      add: (...names: string[]) => {
        for (const name of names) if (name && !self.classes.includes(name)) self.classes.push(name);
      },
      remove: (...names: string[]) => {
        self.classes = self.classes.filter((item) => !names.includes(item));
      },
      contains: (name: string) => self.classes.includes(name),
      toggle: (name: string, force?: boolean) => {
        const has = self.classes.includes(name);
        const next = force === undefined ? !has : force;
        if (next && !has) self.classes.push(name);
        if (!next && has) self.classes = self.classes.filter((item) => item !== name);
        return next;
      },
    };
  }

  get dataset() {
    const self = this;
    const toAttr = (key: string) => `data-${String(key).replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`;
    return new Proxy({} as Record<string, string>, {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        return self.attributes[toAttr(key)];
      },
      set(_target, key, value) {
        self.attributes[toAttr(String(key))] = String(value);
        return true;
      },
      has(_target, key) {
        return toAttr(String(key)) in self.attributes;
      },
    });
  }

  setAttribute(name: string, value: string): void {
    if (name === "class") {
      this.className = String(value);
      return;
    }
    if (name === "hidden") {
      this.hidden = true;
      return;
    }
    if (name === "disabled") {
      this.disabled = true;
      return;
    }
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className || null;
    if (name === "hidden") return this.hidden ? "" : null;
    if (name === "disabled") return this.disabled ? "" : null;
    if (name === "value") return this.value || null;
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }

  querySelector(selector: string): ShimElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ShimElement[] {
    const result: ShimElement[] = [];
    for (const child of this.children) {
      if (matches(child, selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
}

/** Supports `tag`, `.class`, `#id`, `[attr]`, `[attr="value"]` and their compounds. */
export function matches(element: ShimElement, selector: string): boolean {
  const pattern = /([a-zA-Z][a-zA-Z0-9-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(selector))) {
    if (match.index !== consumed) return false;
    consumed = match.index + match[0].length;
    if (match[1]) {
      if (element.tagName !== match[1].toUpperCase()) return false;
    } else if (match[2]) {
      if (!element.classList.contains(match[2])) return false;
    } else if (match[3]) {
      if (element.id !== match[3]) return false;
    } else if (match[4]) {
      const actual = element.getAttribute(match[4]);
      if (actual === null) return false;
      if (match[5] !== undefined && actual !== match[5]) return false;
    }
  }
  return consumed === selector.length && consumed > 0;
}

export type ShimDocument = {
  createElement(tagName: string): ShimElement;
  createTextNode(value: string): ShimText;
};

export function createDocument(): ShimDocument {
  return {
    createElement: (tagName: string) => new ShimElement(tagName),
    createTextNode: (value: string) => new ShimText(value),
  };
}

/** Installs `document` on globalThis; returns the shim document. */
export function installDom(): ShimDocument {
  const documentShim = createDocument();
  (globalThis as any).document = documentShim;
  return documentShim;
}

const VOID_TAGS = new Set(["input", "br", "img", "hr", "meta", "link"]);

const PROPERTY_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "rel"],
  input: ["type", "placeholder", "autocomplete", "value", "readonly"],
  button: ["type", "title"],
  code: ["title"],
  option: ["value"],
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toHTML(node: any, depth = 0): string {
  if (!node) return "";
  const pad = "  ".repeat(depth);
  if (node.nodeType === 3) {
    const text = String(node.nodeValue ?? "").trim();
    return text ? `${pad}${escapeHtml(text)}\n` : "";
  }
  const tag = String(node.tagName).toLowerCase();
  const attributes: string[] = [];
  const seen = new Set<string>();
  if (node.className) {
    attributes.push(`class="${escapeHtml(String(node.className))}"`);
    seen.add("class");
  }
  for (const key of Object.keys(node.attributes).sort()) {
    if (key === "class" || seen.has(key)) continue;
    attributes.push(`${key}="${escapeHtml(String(node.attributes[key]))}"`);
    seen.add(key);
  }
  if (node.hidden) attributes.push("hidden");
  if (node.disabled) attributes.push("disabled");
  if (node.readOnly) attributes.push("readonly");
  for (const property of PROPERTY_ATTRIBUTES[tag] ?? []) {
    if (seen.has(property)) continue;
    const value = node[property];
    if (value === undefined || value === null || value === "" || value === false) continue;
    attributes.push(`${property}="${escapeHtml(String(value))}"`);
    seen.add(property);
  }
  if (tag === "option" && !seen.has("selected")) {
    const parent = node.parentNode;
    if (node.selected || (parent && parent.tagName === "SELECT" && parent.value === node.value)) {
      attributes.push("selected");
    }
  }
  const open = `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  if (VOID_TAGS.has(tag)) return `${pad}${open}\n`;
  // Verbatim markup from `innerHTML` first, then any nodes appended afterwards.
  const raw = typeof node.rawHTML === "string" ? node.rawHTML : "";
  const children = raw + node.childNodes.map((child: any) => toHTML(child, depth + 1)).join("");
  if (!children) return `${pad}${open}</${tag}>\n`;
  return `${pad}${open}\n${children}${pad}</${tag}>\n`;
}

export function textOf(node: any): string {
  return node ? node.textContent : "";
}
