/**
 * YAML parse/stringify on js-yaml's default schema (YAML 1.2 core plus
 * timestamps and merge keys). An empty document parses to null, a stream with
 * more than one document makes parse throw (use parseAll), and duplicate keys
 * throw.
 */

import yaml from "js-yaml";

/** Parse a single-document YAML string. An empty document is null. */
export function parse(content: string): unknown {
  return yaml.load(content) ?? null;
}

/** Parse every document of a YAML stream. Empty documents are null. */
export function parseAll(content: string): unknown[] {
  return yaml.loadAll(content).map((doc) => doc ?? null);
}

/** Serialize a value as block-style YAML (lineWidth -1 disables folding). */
export function stringify(
  data: unknown,
  options: { lineWidth?: number; indent?: number; sortKeys?: boolean } = {},
): string {
  return yaml.dump(data, options);
}
