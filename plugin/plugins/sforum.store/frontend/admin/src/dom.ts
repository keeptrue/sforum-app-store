// Small element builders. No emoji, no inline SVG: a hand-written ESM page has no
// Host icon runtime, so every affordance is text.

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function badge(
  label: string,
  tone: "neutral" | "ok" | "bad" | "warn" | "muted" | "accent" = "neutral",
): HTMLElement {
  const className = tone === "neutral" ? "sfstore__badge" : `sfstore__badge sfstore__badge--${tone}`;
  return el("span", className, label);
}

export function mono(value: string, fullValue?: string): HTMLElement {
  const node = el("code", "sfstore__mono", value);
  if (fullValue) node.title = fullValue;
  return node;
}

export function buttonEl(label: string, variant: "primary" | "ghost" = "ghost"): HTMLButtonElement {
  const node = el("button", variant === "primary" ? "sfstore__btn sfstore__btn--primary" : "sfstore__btn", label) as HTMLButtonElement;
  node.type = "button";
  return node;
}

export function fieldEl(labelText: string, control: HTMLElement, extraClass?: string): HTMLElement {
  const wrap = el("label", extraClass ? `sfstore__field ${extraClass}` : "sfstore__field");
  wrap.append(el("span", "sfstore__label", labelText), control);
  return wrap;
}

/**
 * 文字开关：`<label class="sfstore__toggle"><input type="checkbox" class="sfstore__toggle-input">
 * <span class="sfstore__toggle-text">…</span></label>`。
 *
 * 手写 ESM 没有 Host 图标运行时，开关本身就是文字，不用 emoji，也不画 SVG。返回输入框是因为
 * 调用方要读 `checked` 并挂 `change`；展示/隐藏由 label 的 `hidden` 控制。
 */
export function toggleEl(
  labelText: string,
  options: { checked?: boolean } = {},
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = el("label", "sfstore__toggle") as HTMLLabelElement;
  const input = el("input", "sfstore__toggle-input") as HTMLInputElement;
  input.type = "checkbox";
  input.checked = options.checked === true;
  label.append(input, el("span", "sfstore__toggle-text", labelText));
  return { label, input };
}

export function selectEl(
  options: ReadonlyArray<{ value: string; label: string }>,
  value?: string,
): HTMLSelectElement {
  const node = el("select", "sfstore__input") as HTMLSelectElement;
  for (const option of options) {
    const item = el("option", undefined, option.label) as HTMLOptionElement;
    item.value = option.value;
    node.append(item);
  }
  if (value !== undefined) node.value = value;
  return node;
}
