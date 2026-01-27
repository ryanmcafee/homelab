#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read --allow-write

/**
 * SOPS Bootstrap Script
 *
 * Automates the setup of SOPS encryption for GitOps secrets management.
 * - Generates age key pair (if not exists)
 * - Stores keys in 1Password
 * - Updates .sops.yaml with the public key
 * - Provides instructions for encrypting secrets
 *
 * Usage:
 *   deno run --allow-all scripts/sops-bootstrap.ts
 *
 * Options:
 *   --force         Regenerate keys even if they exist
 *   --encrypt       Encrypt the 1Password credentials after setup
 *   --dry-run       Show what would be done without executing
 */

import { parseArgs } from "jsr:@std/cli/parse-args";

interface CommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
  code: number;
}

const ONEPASSWORD_VAULT = Deno.env.get("ONEPASSWORD_VAULT") || "";
if (!ONEPASSWORD_VAULT) {
  console.error("ERROR: ONEPASSWORD_VAULT environment variable not set");
  console.error("Run with: op run --env-file=.env.op -- deno run ...");
  Deno.exit(1);
}
const ONEPASSWORD_ITEM = "sops-age-key";
const SOPS_CONFIG_PATH = ".sops.yaml";
const SECRETS_PATH = "charts/secrets/onepassword/onepassword-credentials.sops.yaml";

// Parse command line arguments
const args = parseArgs(Deno.args, {
  boolean: ["force", "encrypt", "dry-run", "help"],
  default: {
    force: false,
    encrypt: false,
    "dry-run": false,
    help: false,
  },
});

if (args.help) {
  console.log(`
SOPS Bootstrap Script

Sets up SOPS encryption with age keys stored in 1Password.

Usage:
  deno run --allow-all scripts/sops-bootstrap.ts [options]

Options:
  --force         Regenerate keys even if they exist in 1Password
  --encrypt       Encrypt the 1Password credentials after setup
  --dry-run       Show what would be done without executing
  --help          Show this help message

Steps performed:
  1. Check if age key exists in 1Password
  2. Generate new age key pair (if needed)
  3. Store keys in 1Password
  4. Update .sops.yaml with public key
  5. (Optional) Encrypt 1Password credentials secret
`);
  Deno.exit(0);
}

/**
 * Run a command and capture output
 */
async function runCommand(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<CommandResult> {
  const process = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: options.cwd,
    env: { ...Deno.env.toObject(), ...options.env },
    stdout: "piped",
    stderr: "piped",
  });

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
 * Check if age is installed
 */
async function checkAgeInstalled(): Promise<boolean> {
  const result = await runCommand(["which", "age-keygen"]);
  return result.success;
}

/**
 * Check if sops is installed
 */
async function checkSopsInstalled(): Promise<boolean> {
  const result = await runCommand(["which", "sops"]);
  return result.success;
}

/**
 * Check if 1Password CLI is installed and authenticated
 */
async function check1PasswordAuth(): Promise<boolean> {
  const result = await runCommand(["op", "whoami"]);
  return result.success;
}

/**
 * Check if age key exists in 1Password
 */
async function checkAgeKeyExists(): Promise<boolean> {
  const result = await runCommand([
    "op", "item", "get", ONEPASSWORD_ITEM,
    "--vault", ONEPASSWORD_VAULT,
    "--format", "json",
  ]);
  return result.success;
}

/**
 * Get existing age public key from 1Password
 */
async function getExistingPublicKey(): Promise<string | null> {
  const result = await runCommand([
    "op", "read", `op://${ONEPASSWORD_VAULT}/${ONEPASSWORD_ITEM}/public_key`,
  ]);
  if (result.success) {
    return result.stdout.trim();
  }
  return null;
}

/**
 * Generate a new age key pair
 */
async function generateAgeKey(): Promise<{ publicKey: string; privateKey: string }> {
  log("Generating new age key pair...");

  const result = await runCommand(["age-keygen"]);
  if (!result.success) {
    throw new Error(`Failed to generate age key: ${result.stderr}`);
  }

  // Parse the output - age-keygen outputs to stderr for public key comment
  const lines = result.stdout.split("\n");
  let publicKey = "";
  const privateKeyLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("# public key:")) {
      publicKey = line.replace("# public key:", "").trim();
    } else if (line.startsWith("AGE-SECRET-KEY-") || privateKeyLines.length > 0) {
      privateKeyLines.push(line);
    }
  }

  // Also check stderr for public key (age-keygen behavior varies)
  for (const line of result.stderr.split("\n")) {
    if (line.startsWith("Public key:")) {
      publicKey = line.replace("Public key:", "").trim();
    }
  }

  const privateKey = privateKeyLines.join("\n").trim();

  if (!publicKey || !privateKey) {
    throw new Error("Failed to parse age key output");
  }

  return { publicKey, privateKey };
}

/**
 * Store age keys in 1Password
 */
async function storeKeysIn1Password(publicKey: string, privateKey: string): Promise<void> {
  log("Storing age keys in 1Password...");

  if (args["dry-run"]) {
    log(`Would create 1Password item: ${ONEPASSWORD_VAULT}/${ONEPASSWORD_ITEM}`, "warning");
    return;
  }

  // Create or update the 1Password item
  const result = await runCommand([
    "op", "item", "create",
    "--vault", ONEPASSWORD_VAULT,
    "--category", "Secure Note",
    "--title", ONEPASSWORD_ITEM,
    `public_key=${publicKey}`,
    `private_key=${privateKey}`,
    "notes=SOPS age encryption key for GitOps secrets. Generated by scripts/sops-bootstrap.ts",
  ]);

  if (!result.success) {
    // Item might already exist, try to edit
    const editResult = await runCommand([
      "op", "item", "edit", ONEPASSWORD_ITEM,
      "--vault", ONEPASSWORD_VAULT,
      `public_key=${publicKey}`,
      `private_key=${privateKey}`,
    ]);

    if (!editResult.success) {
      throw new Error(`Failed to store keys in 1Password: ${editResult.stderr}`);
    }
  }

  log(`Keys stored in 1Password: ${ONEPASSWORD_VAULT}/${ONEPASSWORD_ITEM}`, "success");
}

/**
 * Update .sops.yaml with the public key
 */
async function updateSopsConfig(publicKey: string): Promise<void> {
  log(`Updating ${SOPS_CONFIG_PATH} with public key...`);

  if (args["dry-run"]) {
    log(`Would update ${SOPS_CONFIG_PATH} with key: ${publicKey}`, "warning");
    return;
  }

  const sopsConfig = `# SOPS configuration for encrypting secrets
# Age public key is used for encryption, private key for decryption
# The age private key is stored in 1Password: op://${ONEPASSWORD_VAULT}/${ONEPASSWORD_ITEM}/private_key

creation_rules:
  # Encrypt Kubernetes secrets
  - path_regex: .*\\.sops\\.ya?ml$
    encrypted_regex: ^(data|stringData)$
    age: ${publicKey}

  # Encrypt any secrets in the secrets directory
  - path_regex: secrets/.*\\.ya?ml$
    encrypted_regex: ^(data|stringData)$
    age: ${publicKey}
`;

  await Deno.writeTextFile(SOPS_CONFIG_PATH, sopsConfig);
  log(`Updated ${SOPS_CONFIG_PATH}`, "success");
}

/**
 * Create template for 1Password credentials secret
 */
async function createCredentialsTemplate(): Promise<void> {
  const templatePath = SECRETS_PATH.replace(".sops.yaml", ".template.yaml");

  log(`Creating credentials template at ${templatePath}...`);

  if (args["dry-run"]) {
    log(`Would create template at ${templatePath}`, "warning");
    return;
  }

  const template = `# 1Password Connect Credentials
# Fill in the values below, then encrypt with:
#   sops --encrypt ${templatePath} > ${SECRETS_PATH}
#
# Get credentials from: 1Password > Integrations > 1Password Connect Server
apiVersion: v1
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
  # Paste the contents of your 1password-credentials.json file here
  # Get it from: 1Password.com > Settings > Integrations > Connect Server > Download Credentials
  1password-credentials.json: |
    {
      "verifier": "...",
      "encCredentials": "...",
      "version": "1"
    }
  # Your 1Password Connect token
  # Get it from: 1Password.com > Settings > Integrations > Connect Server > Access Tokens
  token: "your-connect-token-here"
`;

  await Deno.writeTextFile(templatePath, template);
  log(`Created template at ${templatePath}`, "success");
  log(`Edit the template with your credentials, then run: task sops:encrypt`, "info");
}

/**
 * Encrypt the credentials file
 */
async function encryptCredentials(): Promise<void> {
  const templatePath = SECRETS_PATH.replace(".sops.yaml", ".template.yaml");

  // Check if template exists
  try {
    await Deno.stat(templatePath);
  } catch {
    log(`Template file not found: ${templatePath}`, "error");
    log("Create and fill in the template first, then run with --encrypt", "info");
    return;
  }

  log(`Encrypting ${templatePath} -> ${SECRETS_PATH}...`);

  if (args["dry-run"]) {
    log(`Would encrypt ${templatePath} to ${SECRETS_PATH}`, "warning");
    return;
  }

  const result = await runCommand([
    "sops", "--encrypt", templatePath,
  ]);

  if (!result.success) {
    throw new Error(`Failed to encrypt: ${result.stderr}`);
  }

  await Deno.writeTextFile(SECRETS_PATH, result.stdout);
  log(`Encrypted credentials saved to ${SECRETS_PATH}`, "success");

  // Remove the unencrypted template
  await Deno.remove(templatePath);
  log(`Removed unencrypted template: ${templatePath}`, "success");
}

/**
 * Main bootstrap function
 */
async function main(): Promise<void> {
  console.log("\n=== SOPS Bootstrap ===\n");

  // Check prerequisites
  log("Checking prerequisites...");

  if (!await checkAgeInstalled()) {
    log("age is not installed. Install with: brew install age", "error");
    Deno.exit(1);
  }

  if (!await checkSopsInstalled()) {
    log("sops is not installed. Install with: brew install sops", "error");
    Deno.exit(1);
  }

  if (!await check1PasswordAuth()) {
    log("1Password CLI not authenticated. Run: eval $(op signin)", "error");
    Deno.exit(1);
  }

  log("Prerequisites OK", "success");

  // Check if key already exists
  const keyExists = await checkAgeKeyExists();
  let publicKey: string;

  if (keyExists && !args.force) {
    log(`Age key already exists in 1Password: ${ONEPASSWORD_VAULT}/${ONEPASSWORD_ITEM}`);
    publicKey = await getExistingPublicKey() || "";
    if (!publicKey) {
      log("Could not retrieve public key from 1Password", "error");
      Deno.exit(1);
    }
    log(`Using existing public key: ${publicKey}`, "info");
  } else {
    if (keyExists && args.force) {
      log("Regenerating keys (--force specified)", "warning");
    }

    // Generate new keys
    const keys = await generateAgeKey();
    publicKey = keys.publicKey;
    log(`Generated public key: ${publicKey}`, "success");

    // Store in 1Password
    await storeKeysIn1Password(keys.publicKey, keys.privateKey);
  }

  // Update .sops.yaml
  await updateSopsConfig(publicKey);

  // Create template for credentials
  await createCredentialsTemplate();

  // Encrypt if requested
  if (args.encrypt) {
    await encryptCredentials();
  }

  console.log("\n=== Bootstrap Complete ===\n");
  log("Next steps:", "info");
  console.log("  1. Edit the credentials template with your 1Password Connect credentials");
  console.log("  2. Run: task sops:encrypt");
  console.log("  3. Commit the encrypted secret to git");
  console.log("  4. Run: task tf:apply:component COMPONENT=gitops-bootstrap");
  console.log("");
}

// Run main
main().catch((error) => {
  log(`Bootstrap failed: ${error.message}`, "error");
  Deno.exit(1);
});
