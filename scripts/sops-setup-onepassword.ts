#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read --allow-write

/**
 * SOPS 1Password Credentials Setup
 *
 * Automates the setup of SOPS-encrypted 1Password Connect credentials.
 * - Pulls credentials from 1Password (credentials file + token)
 * - Creates the Kubernetes secret YAML
 * - Encrypts with SOPS
 * - Optionally commits the changes
 *
 * Usage:
 *   deno run --allow-all scripts/sops-setup-onepassword.ts
 *
 * Options:
 *   --commit      Commit the encrypted secret after creation
 *   --dry-run     Show what would be done without executing
 */

import { parseArgs } from "jsr:@std/cli/parse-args";

interface CommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
  code: number;
}

const ONEPASSWORD_VAULT = "homelab";
const ONEPASSWORD_CONNECT_ITEM = "onepassword-connect";
const SECRETS_PATH = "charts/secrets/onepassword/onepassword-credentials.sops.yaml";
const TEMPLATE_PATH = "charts/secrets/onepassword/onepassword-credentials.template.yaml";

// Parse command line arguments
const args = parseArgs(Deno.args, {
  boolean: ["commit", "dry-run", "help"],
  default: {
    commit: false,
    "dry-run": false,
    help: false,
  },
});

if (args.help) {
  console.log(`
SOPS 1Password Credentials Setup

Pulls 1Password Connect credentials and encrypts them with SOPS.

Usage:
  deno run --allow-all scripts/sops-setup-onepassword.ts [options]

Options:
  --commit      Commit the encrypted secret after creation
  --dry-run     Show what would be done without executing
  --help        Show this help message

Prerequisites:
  - 1Password CLI authenticated (op signin)
  - SOPS and age installed
  - .sops.yaml configured with age public key
  - 1Password item '${ONEPASSWORD_CONNECT_ITEM}' in vault '${ONEPASSWORD_VAULT}' with:
    - Attached file: 1password-credentials.json
    - Field: connect_token
`);
  Deno.exit(0);
}

/**
 * Run a command and capture output
 */
async function runCommand(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}
): Promise<CommandResult> {
  const process = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: options.cwd,
    env: { ...Deno.env.toObject(), ...options.env },
    stdout: "piped",
    stderr: "piped",
    stdin: options.stdin ? "piped" : undefined,
  });

  if (options.stdin) {
    const child = process.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
    const { code, stdout, stderr } = await child.output();
    return {
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      success: code === 0,
      code,
    };
  }

  const { code, stdout, stderr } = await process.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    success: code === 0,
    code,
  };
}

/**
 * Log with color and prefix
 */
function log(message: string, type: "info" | "success" | "error" | "warning" = "info") {
  const colors = {
    info: "\x1b[36m",    // Cyan
    success: "\x1b[32m", // Green
    error: "\x1b[31m",   // Red
    warning: "\x1b[33m", // Yellow
  };
  const reset = "\x1b[0m";
  const prefix = {
    info: "INFO",
    success: "OK",
    error: "ERROR",
    warning: "WARN",
  };
  console.log(`${colors[type]}[${prefix[type]}]${reset} ${message}`);
}

/**
 * Check if 1Password CLI is authenticated
 */
async function check1PasswordAuth(): Promise<boolean> {
  const result = await runCommand(["op", "whoami"]);
  return result.success;
}

/**
 * Get the 1Password credentials file content
 */
async function getCredentialsFile(): Promise<string> {
  log("Fetching 1password-credentials.json from 1Password...");

  // The credentials file is attached to the onepassword-connect item
  const result = await runCommand([
    "op", "read", `op://${ONEPASSWORD_VAULT}/${ONEPASSWORD_CONNECT_ITEM}/1password-credentials.json`,
  ]);

  if (!result.success) {
    throw new Error(`Failed to get credentials file: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Get the 1Password connect token
 */
async function getConnectToken(): Promise<string> {
  log("Fetching connect token from 1Password...");

  const result = await runCommand([
    "op", "read", `op://${ONEPASSWORD_VAULT}/${ONEPASSWORD_CONNECT_ITEM}/connect_token`,
  ]);

  if (!result.success) {
    throw new Error(`Failed to get connect token: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * Create the Kubernetes secret YAML
 */
function createSecretYaml(credentialsJson: string, token: string): string {
  // Indent the JSON for YAML multiline string
  const indentedJson = credentialsJson
    .split("\n")
    .map((line, i) => (i === 0 ? line : `    ${line}`))
    .join("\n");

  return `apiVersion: v1
kind: Secret
metadata:
  name: onepassword-credentials
  namespace: onepassword-operator
  labels:
    app.kubernetes.io/name: onepassword-credentials
    app.kubernetes.io/managed-by: sops
    app.kubernetes.io/part-of: gitops-bootstrap
type: Opaque
stringData:
  1password-credentials.json: |
    ${indentedJson}
  token: "${token}"
`;
}

/**
 * Encrypt the secret with SOPS
 */
async function encryptWithSops(yamlContent: string): Promise<string> {
  log("Encrypting secret with SOPS...");

  // Get the project root directory (where .sops.yaml is located)
  const projectRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
  const sopsConfigPath = `${projectRoot}/.sops.yaml`;

  // Write temp file in project directory so SOPS path regex matches
  const tempFile = `${projectRoot}/charts/secrets/onepassword/.tmp-credentials.yaml`;
  await Deno.writeTextFile(tempFile, yamlContent);

  const result = await runCommand([
    "sops", "--encrypt",
    "--config", sopsConfigPath,
    tempFile,
  ]);

  // Clean up temp file
  await Deno.remove(tempFile);

  if (!result.success) {
    throw new Error(`Failed to encrypt with SOPS: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Commit the changes
 */
async function commitChanges(): Promise<void> {
  log("Committing encrypted secret...");

  await runCommand(["git", "add", SECRETS_PATH, ".sops.yaml"]);

  const result = await runCommand([
    "git", "commit", "-m", "feat(sops): add encrypted 1Password Connect credentials\n\nCredentials pulled from 1Password and encrypted with SOPS.\nAge key stored in 1Password for decryption.",
  ]);

  if (!result.success) {
    throw new Error(`Failed to commit: ${result.stderr}`);
  }

  log("Changes committed", "success");
}

/**
 * Main setup function
 */
async function main(): Promise<void> {
  console.log("\n=== SOPS 1Password Credentials Setup ===\n");

  // Check prerequisites
  log("Checking prerequisites...");

  if (!await check1PasswordAuth()) {
    log("1Password CLI not authenticated. Run: eval $(op signin)", "error");
    Deno.exit(1);
  }

  log("Prerequisites OK", "success");

  if (args["dry-run"]) {
    log("Dry run mode - no changes will be made", "warning");
  }

  // Fetch credentials from 1Password
  const credentialsJson = await getCredentialsFile();
  const connectToken = await getConnectToken();

  log("Retrieved credentials from 1Password", "success");

  // Create the secret YAML
  const secretYaml = createSecretYaml(credentialsJson, connectToken);

  if (args["dry-run"]) {
    log("Would create and encrypt secret YAML", "warning");
    console.log("\n--- Secret YAML (unencrypted preview) ---");
    console.log(secretYaml.replace(connectToken, "[REDACTED]").replace(/("encCredentials":\s*")[^"]+/, '$1[REDACTED]'));
    console.log("--- End preview ---\n");
    return;
  }

  // Encrypt with SOPS
  const encryptedYaml = await encryptWithSops(secretYaml);

  // Write encrypted secret
  await Deno.writeTextFile(SECRETS_PATH, encryptedYaml);
  log(`Encrypted secret saved to ${SECRETS_PATH}`, "success");

  // Remove template if it exists
  try {
    await Deno.remove(TEMPLATE_PATH);
    log(`Removed template file: ${TEMPLATE_PATH}`, "success");
  } catch {
    // Template doesn't exist, that's fine
  }

  // Commit if requested
  if (args.commit) {
    await commitChanges();
  }

  console.log("\n=== Setup Complete ===\n");
  log("Next steps:", "info");
  if (!args.commit) {
    console.log("  1. Review the encrypted secret: git diff");
    console.log("  2. Commit the changes: git add -A && git commit -m 'feat(sops): add encrypted 1Password credentials'");
  }
  console.log("  3. Push to remote: git push");
  console.log("  4. Apply gitops-bootstrap: task tf:apply:component COMPONENT=gitops-bootstrap");
  console.log("");
}

// Run main
main().catch((error) => {
  log(`Setup failed: ${error.message}`, "error");
  Deno.exit(1);
});
