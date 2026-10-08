import { Fragment, type ReactNode } from "react";

/**
 * Fills `{placeholders}` of an (already translated) sentence with React nodes, so a bold number or a badge can sit
 * inside one translatable string instead of the sentence being cut into fragments:
 *   rich(t("Showing {a} of {b} models"), { a: <b>48</b>, b: <b>809</b> })
 */
export function rich(template: string, vars: Record<string, ReactNode>): ReactNode {
  return template.split(/\{(\w+)\}/g).map((part, i) => (i % 2 ? <Fragment key={i}>{vars[part] ?? `{${part}}`}</Fragment> : part));
}
