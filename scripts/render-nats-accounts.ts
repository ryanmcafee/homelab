#!/usr/bin/env bun
/**
 * Renders contracts/events/bus-principals.v1.yaml into the per-principal permission sets the
 * addons chart feeds to the NATS server's `accounts {}` block.
 *
 * A tenant's permission set is GENERATED from the declaration, never hand-written per customer
 * (docs/contracts/byo-extension-points.md). charts/addons cannot read `contracts/` at render time
 * -- Helm's `.Files.Get` is scoped to the chart directory -- so the expansion happens here and the
 * result is committed at charts/addons/files/nats-accounts.gen.yaml. The committed copy is pinned
 * to the declaration by the parity assertion in scripts/nats-principals-contract_test.ts, which is
 * what stops the two drifting.
 *
 * What this file does NOT emit, and must not: any key, any account name for a real deployment, any
 * tenant token other than the `<tenant>` placeholder. Identity is operator-supplied
 * (`nats.principalNkeys`); permissions are contract.
 *
 *   bun scripts/render-nats-accounts.ts          # write the artifact
 *   bun scripts/render-nats-accounts.ts --check  # fail when it is stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "./lib/yaml.ts";

const ROOT = join(import.meta.dir, "..");
const DECLARATION_PATH = join(
  ROOT,
  "contracts",
  "events",
  "bus-principals.v1.yaml",
);
export const ARTIFACT_PATH = join(
  ROOT,
  "charts",
  "addons",
  "files",
  "nats-accounts.gen.yaml",
);

interface Role {
  js_api_allow: string[];
  js_api_deny: string[];
}

interface Consumes {
  stream: string;
  consumer: string;
  filter: string;
}

interface Principal {
  name: string;
  role: string;
  publish: string[];
  subscribe: string[];
  consumes?: Consumes[];
  pending?: string;
}

interface Declaration {
  version: number;
  accounts: {
    name_template: string;
    system_account: string;
    jetstream_limits_required: string[];
  };
  subject_grants: {
    inbox_subscribe_template: string;
    ack_templates: string[];
  };
  roles: Record<string, Role>;
  principals: Principal[];
}

/** A rendered principal: one NATS user, minus the nkey the operator supplies. */
export interface RenderedPrincipal {
  name: string;
  role: string;
  pending?: string;
  publish: { allow: string[]; deny: string[] };
  subscribe: { allow: string[] };
}

export interface Artifact {
  version: number;
  source: string;
  systemAccount: string;
  accountNameTemplate: string;
  jetstreamLimitsRequired: string[];
  principals: RenderedPrincipal[];
}

function substitute(template: string, bind: Consumes): string {
  return template
    .replaceAll("<stream>", bind.stream)
    .replaceAll("<consumer>", bind.consumer)
    .replaceAll("<filter>", bind.filter);
}

function needsBind(template: string): boolean {
  return (
    template.includes("<stream>") ||
    template.includes("<consumer>") ||
    template.includes("<filter>")
  );
}

/** Order-stable and duplicate-free: the same declaration renders the same bytes. */
function unique(subjects: string[]): string[] {
  return [...new Set(subjects)];
}

export function render(declaration: Declaration): Artifact {
  const principals: RenderedPrincipal[] = [];

  for (const principal of declaration.principals) {
    const role = declaration.roles[principal.role];
    if (role === undefined) {
      throw new Error(
        `principal ${principal.name} names role ${principal.role}, which the declaration does not define`,
      );
    }
    const binds = principal.consumes ?? [];
    const publishAllow = [...principal.publish];

    for (const endpoint of role.js_api_allow) {
      if (!needsBind(endpoint)) {
        publishAllow.push(endpoint);
        continue;
      }
      if (binds.length === 0) {
        throw new Error(
          `principal ${principal.name} holds role ${principal.role}, whose endpoint ${endpoint} names a stream, but the principal consumes nothing`,
        );
      }
      for (const bind of binds) publishAllow.push(substitute(endpoint, bind));
    }

    // ACK subjects are PUBLISHED by the consumer, so they belong to the publish side. Both
    // server forms are granted, each pinned to this principal's own stream and consumer.
    for (const bind of binds) {
      for (const template of declaration.subject_grants.ack_templates) {
        publishAllow.push(substitute(template, bind));
      }
    }

    const rendered: RenderedPrincipal = {
      name: principal.name,
      role: principal.role,
      publish: {
        allow: unique(publishAllow),
        deny: unique(role.js_api_deny),
      },
      subscribe: {
        allow: unique([
          ...principal.subscribe,
          // Generated from the principal name, never declared: a declared inbox grant could
          // name another principal's prefix (ADR-043 D5a).
          declaration.subject_grants.inbox_subscribe_template.replaceAll(
            "<principal>",
            principal.name,
          ),
        ]),
      },
    };
    if (principal.pending !== undefined) rendered.pending = principal.pending;
    principals.push(rendered);
  }

  return {
    version: declaration.version,
    source: "contracts/events/bus-principals.v1.yaml",
    systemAccount: declaration.accounts.system_account,
    accountNameTemplate: declaration.accounts.name_template,
    jetstreamLimitsRequired: declaration.accounts.jetstream_limits_required,
    principals,
  };
}

const HEADER = `# GENERATED by scripts/render-nats-accounts.ts from
# contracts/events/bus-principals.v1.yaml. Do not edit: regenerate with
# \`bun scripts/render-nats-accounts.ts\`. \`task test:scripts\` fails when this file and the
# declaration disagree.
#
# charts/addons/templates/nats.yaml expands this into the server's \`accounts {}\` block, one
# account per tenant, substituting the tenant token and the operator-supplied public nkeys. No
# key, no real account name and no tenant token other than \`<tenant>\` appears here.
`;

export function serialize(artifact: Artifact): string {
  return `${HEADER}${stringifyYaml(artifact, { lineWidth: -1 })}`;
}

export function renderFromDeclaration(): string {
  return serialize(
    render(parseYaml(readFileSync(DECLARATION_PATH, "utf8")) as Declaration),
  );
}

if (import.meta.main) {
  const expected = renderFromDeclaration();
  if (process.argv.includes("--check")) {
    const actual = readFileSync(ARTIFACT_PATH, "utf8");
    if (actual !== expected) {
      console.error(
        "charts/addons/files/nats-accounts.gen.yaml is stale; run `bun scripts/render-nats-accounts.ts`",
      );
      process.exit(1);
    }
    console.log("nats-accounts.gen.yaml matches the declaration");
  } else {
    writeFileSync(ARTIFACT_PATH, expected);
    console.log(`wrote ${ARTIFACT_PATH}`);
  }
}
