/** Small DOM helpers for the studio's left panel (styled in style.css under #studio). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(
  parent: HTMLElement,
  label: string,
  title: string,
  onClick: () => void,
  cls = 'small',
): HTMLButtonElement {
  const b = el('button', cls, label);
  b.title = title;
  b.onclick = onClick;
  parent.appendChild(b);
  return b;
}

/** A control that re-reads its value from whatever it is bound to. */
export interface Synced {
  sync(): void;
}

export interface RangeSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  /** Shown after the number. */
  unit?: string;
  hint: string;
}

/** A labelled slider with its value; `get` / `set` are in display units. */
export function rangeRow(
  parent: HTMLElement,
  spec: RangeSpec,
  get: () => number,
  set: (x: number) => void,
): Synced & { row: HTMLLabelElement; input: HTMLInputElement; name: HTMLSpanElement; unit: string } {
  const row = el('label', 'slider');
  row.title = spec.hint;
  const name = el('span', 'name', spec.label);
  const input = el('input');
  Object.assign(input, { type: 'range', min: `${spec.min}`, max: `${spec.max}`, step: `${spec.step}` });
  const output = el('output');
  const control = {
    row,
    input,
    name,
    unit: spec.unit ?? '',
    sync() {
      input.value = `${get()}`;
      // Decimals follow the input's current step (it can change, e.g. the brush value per tool).
      const step = +input.step;
      const digits = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
      output.textContent = `${(+input.value).toFixed(digits)}${control.unit ? ` ${control.unit}` : ''}`;
    },
  };
  input.oninput = () => {
    set(+input.value);
    control.sync();
  };
  // Click the value to type one: Enter or leaving the field sets it (within the slider's range), Esc cancels.
  output.title = 'Click to type a value';
  output.onclick = (e) => {
    e.preventDefault(); // (the label would focus the slider)
    const field = el('input', 'value-edit');
    field.type = 'text';
    field.inputMode = 'decimal';
    field.value = `${+input.value}`;
    output.replaceWith(field);
    field.focus();
    field.select();
    // Once: taking the field out blurs it, which would commit a cancelled edit.
    let closed = false;
    const done = (commit: boolean) => {
      if (closed) return;
      closed = true;
      const x = parseFloat(field.value);
      field.replaceWith(output);
      if (commit && Number.isFinite(x)) {
        input.value = `${Math.min(spec.max, Math.max(spec.min, x))}`;
        set(+input.value);
      }
      control.sync();
    };
    field.onkeydown = (k) => {
      k.stopPropagation();
      if (k.key === 'Enter') done(true);
      else if (k.key === 'Escape') done(false);
    };
    field.onblur = () => done(true);
  };
  row.append(name, input, output);
  parent.appendChild(row);
  control.sync();
  return control;
}

export function checkRow(
  parent: HTMLElement,
  label: string,
  hint: string,
  get: () => boolean,
  set: (v: boolean) => void,
): Synced & { row: HTMLLabelElement } {
  const row = el('label', 'check');
  row.title = hint;
  const input = el('input');
  input.type = 'checkbox';
  input.onchange = () => set(input.checked);
  row.append(input, el('span', '', label));
  parent.appendChild(row);
  const control = { row, sync: () => (input.checked = get()) };
  control.sync();
  return control;
}

/** A colour picker (sRGB hex). */
export function colorInput(
  parent: HTMLElement,
  hint: string,
  get: () => string,
  set: (hex: string) => void,
): Synced & { input: HTMLInputElement } {
  const input = el('input', 'color');
  input.type = 'color';
  input.title = hint;
  input.oninput = () => set(input.value);
  parent.appendChild(input);
  const control = { input, sync: () => (input.value = get()) };
  control.sync();
  return control;
}

/** A collapsible panel section: clicking its title folds it. */
export function section(parent: HTMLElement, title: string, collapsed = false): HTMLElement {
  const s = el('section');
  const h = el('h3', '', title);
  h.onclick = () => s.classList.toggle('collapsed');
  s.classList.toggle('collapsed', collapsed);
  s.appendChild(h);
  parent.appendChild(s);
  return s;
}
