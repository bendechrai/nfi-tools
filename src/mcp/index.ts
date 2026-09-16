import path from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };
import { setSecret, hasSecret, listKeys, diffKeys, removeSecret, copySecret } from "../core/secrets.js";
import { generateSecret, describeTemplate, AVAILABLE_TEMPLATES } from "../core/generate.js";
import { checkGitignore } from "../core/gitignore.js";
import { collectViaBrowserNoAutoOpen } from "../input/browser.js";
import { loadConfig } from "../config/index.js";
import { resolveHandler, detectFormat, type Format } from "../core/formats/index.js";
import { validateKeyName } from "../core/validate.js";

/**
 * Validate and resolve a file path.
 *
 * Absolute paths are accepted as-is (the user explicitly chose the location).
 * Relative paths are resolved against cwd and must stay within it to prevent
 * prompt-injection-driven path traversal (e.g., "../../etc/passwd").
 */
function validateFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);

  if (!path.isAbsolute(filePath)) {
    const cwd = process.cwd();
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      throw new Error(
        `Path "${filePath}" resolves outside the working directory. Only paths within ${cwd} are allowed.`,
      );
    }
  }

  return resolved;
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "nfi",
    version,
  });

  // store_secret
  server.registerTool(
    "store_secret",
    {
      description:
        "Prompt the user to enter secret value(s) via a browser form and write them to a file. " +
        "Returns a URL immediately. Show the URL to the user as a clickable link. " +
        "When the user opens the URL, enters their secrets, and clicks Save, the values are written to the file automatically. " +
        "IMPORTANT: The entire purpose of nfi is to keep secret values OUT of the AI context. " +
        "You MUST NOT read, cat, or open the target file after secrets are written - doing so would defeat the purpose and expose the secrets in your context. " +
        "To verify secrets were saved, use ONLY the check_secret tool, which confirms existence without revealing values.",
      inputSchema: {
        keys: z.array(z.string()).describe("Key name(s) to set in the file"),
        file: z.string().describe("Target file path"),
        format: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override format detection"),
        overwrite: z.boolean().optional().describe("Allow overwriting existing keys"),
      },
    },
    async ({ keys, file, format, overwrite }) => {
      try {
        const validatedFile = validateFilePath(file);
        for (const key of keys) {
          validateKeyName(key);
        }

        // Validate format
        resolveHandler(validatedFile, format);

        // Check existing keys
        const existingKeys: string[] = [];
        try {
          for (const key of keys) {
            const result = await hasSecret(validatedFile, key, { format });
            if (result.exists) {
              existingKeys.push(key);
            }
          }
        } catch {
          // File might not exist yet
        }

        // Block if keys exist and no overwrite
        if (existingKeys.length > 0 && !overwrite) {
          return {
            content: [{
              type: "text" as const,
              text: `Keys already exist: ${existingKeys.join(", ")}. Set overwrite to true to replace them.`,
            }],
            isError: true,
          };
        }

        const config = await loadConfig();
        const session = await collectViaBrowserNoAutoOpen({
          keys,
          file: validatedFile,
          existingKeys: overwrite ? [] : existingKeys,
          timeout: config.timeout,
        });

        // Write values to file automatically when the user submits the form
        session.values.then(async (values) => {
          for (const [key, value] of Object.entries(values)) {
            try {
              await setSecret(validatedFile, key, value, {
                format,
                overwrite: true,
              });
            } catch {
              // Best effort - file write failures are silent since the tool
              // already returned. User can verify with check_secret.
            }
          }
        }).catch(() => {
          // Timeout or error - nothing to do, session is cleaned up by the server
        });

        return {
          content: [{
            type: "text" as const,
            text: `Open this URL to enter your secret values:\n\n${session.url}\n\nThe values will be written to ${file} automatically when submitted.\n\nDo NOT read or open ${file} after submission - it contains secrets. Use check_secret to verify.`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${(err as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  );

  // check_secret
  server.registerTool(
    "check_secret",
    {
      description:
        "Check if a key exists in a file and whether it has a non-empty value. Never reveals the secret value. " +
        "This is the ONLY safe way to verify a secret was written - never read the file directly, as that would expose secrets in the AI context.",
      inputSchema: {
        key: z.string().describe("Key name to check"),
        file: z.string().describe("File to check in"),
        format: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override format detection"),
      },
    },
    async ({ key, file, format }) => {
      try {
        const validatedFile = validateFilePath(file);
        validateKeyName(key);
        const result = await hasSecret(validatedFile, key, { format });

        let message: string;
        if (result.exists) {
          message = result.hasValue
            ? `${key} exists in ${file} and has a non-empty value`
            : `${key} exists in ${file} but has an empty value`;
        } else {
          message = `${key} is not set in ${file}`;
        }

        return {
          content: [{ type: "text" as const, text: message }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // list_keys
  server.registerTool(
    "list_keys",
    {
      description: "List all key names/paths in a file. Only returns key names, never values. Use this instead of reading the file directly.",
      inputSchema: {
        file: z.string().describe("File to list keys from"),
        format: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override format detection"),
        depth: z.number().optional().describe("Limit depth for structured formats (0 = all leaf paths)"),
      },
    },
    async ({ file, format, depth }) => {
      try {
        const validatedFile = validateFilePath(file);
        const keys = await listKeys(validatedFile, { format, depth });
        return {
          content: [{ type: "text" as const, text: keys.length > 0 ? keys.join("\n") : "No keys found" }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // diff_keys
  server.registerTool(
    "diff_keys",
    {
      description: "Compare keys between two files of the same format. Shows which keys are missing from each file. Only compares key names, never reveals values.",
      inputSchema: {
        file1: z.string().describe("First file path"),
        file2: z.string().describe("Second file path"),
        format: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override format detection (applied to both files)"),
      },
    },
    async ({ file1, file2, format }) => {
      try {
        const validatedFile1 = validateFilePath(file1);
        const validatedFile2 = validateFilePath(file2);
        const result = await diffKeys(validatedFile1, validatedFile2, { format });

        const parts: string[] = [];
        if (result.missingFrom1.length === 0 && result.missingFrom2.length === 0) {
          parts.push("Both files have the same keys.");
        } else {
          if (result.missingFrom1.length > 0) {
            parts.push(`Missing from ${file1}: ${result.missingFrom1.join(", ")}`);
          }
          if (result.missingFrom2.length > 0) {
            parts.push(`Missing from ${file2}: ${result.missingFrom2.join(", ")}`);
          }
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // generate_secret
  server.registerTool(
    "generate_secret",
    {
      description:
        "Generate a random secret and write it to a file. The generated value is never revealed. " +
        "Do NOT read the file after writing - use check_secret to verify. Reading the file would expose the secret in the AI context.",
      inputSchema: {
        key: z.string().describe("Key name for the generated secret"),
        file: z.string().describe("Target file path"),
        template: z.string().optional().describe("Generation template (e.g., hex:64, base64:32, uuid, alphanumeric:32)"),
        format: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override format detection"),
        overwrite: z.boolean().optional().describe("Allow overwriting existing keys"),
        dryRun: z.boolean().optional().describe("Show what would be generated without writing"),
      },
    },
    async ({ key, file, template, format, overwrite, dryRun }) => {
      try {
        const validatedFile = validateFilePath(file);
        validateKeyName(key);
        const config = await loadConfig();
        const templateSpec = template || config.generateTemplate;

        if (dryRun) {
          const description = describeTemplate(templateSpec);
          return {
            content: [{
              type: "text" as const,
              text: `Would generate: ${description}\nWould write to: ${file} as ${key}`,
            }],
          };
        }

        const { description } = await generateSecret(validatedFile, key, templateSpec, {
          format,
          overwrite,
        });

        const gitignoreWarning = await checkGitignore(validatedFile);
        const extra = gitignoreWarning ? `\n${gitignoreWarning}` : "";

        return {
          content: [{
            type: "text" as const,
            text: `Generated and wrote ${key} to ${file} (${description})${extra}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // remove_secret
  server.registerTool(
    "remove_secret",
    {
      description: "Remove a key and its value from a file entirely.",
      inputSchema: {
        key: z.string().describe("Key name to remove"),
        file: z.string().describe("File to remove from"),
        format: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override format detection"),
      },
    },
    async ({ key, file, format }) => {
      try {
        const validatedFile = validateFilePath(file);
        validateKeyName(key);
        await removeSecret(validatedFile, key, { format });

        const gitignoreWarning = await checkGitignore(validatedFile);
        const extra = gitignoreWarning ? `\n${gitignoreWarning}` : "";
        return {
          content: [{ type: "text" as const, text: `Removed ${key} from ${file}${extra}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // copy_secret
  server.registerTool(
    "copy_secret",
    {
      description: "Copy a secret from one file to another without exposing its value. The value is read and written internally.",
      inputSchema: {
        key: z.string().describe("Key name in the source file"),
        source: z.string().describe("Source file path"),
        dest: z.string().describe("Destination file path"),
        path: z.string().optional().describe("Target key path in destination (for structured formats, e.g., 'database.password')"),
        format: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override source format detection"),
        destFormat: z.enum(["env", "json", "yaml", "toml"]).optional().describe("Override destination format detection"),
        overwrite: z.boolean().optional().describe("Allow overwriting existing keys in destination"),
      },
    },
    async ({ key, source, dest, path: destKey, format, destFormat, overwrite }) => {
      try {
        const validatedSource = validateFilePath(source);
        const validatedDest = validateFilePath(dest);
        validateKeyName(key);
        if (destKey) validateKeyName(destKey);
        await copySecret(key, validatedSource, validatedDest, {
          format,
          destKey,
          destFormat,
          overwrite,
        });

        const gitignoreWarning = await checkGitignore(validatedDest);
        const extra = gitignoreWarning ? `\n${gitignoreWarning}` : "";

        const targetKey = destKey || key;
        return {
          content: [{
            type: "text" as const,
            text: `Copied ${key} from ${source} to ${dest} as ${targetKey}${extra}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // describe_capabilities
  server.registerTool(
    "describe_capabilities",
    {
      description: "Describe all available nfi tools, supported file formats, generation templates, and current configuration.",
      inputSchema: {},
    },
    async () => {
      const config = await loadConfig();

      const capabilities = {
        commands: [
          { name: "store_secret", description: "Returns a URL for the user to enter secrets; values are written to file on submit" },
          { name: "check_secret", description: "Check if a key exists and has a value (never reveals the value)" },
          { name: "list_keys", description: "List all key names in a file (never reveals values)" },
          { name: "diff_keys", description: "Compare keys between two files of the same format" },
          { name: "generate_secret", description: "Generate a random secret and write to file" },
          { name: "remove_secret", description: "Remove a key from a file" },
          { name: "copy_secret", description: "Copy a secret between files without exposing its value" },
        ],
        formats: ["env", "json", "yaml", "toml"],
        generateTemplates: AVAILABLE_TEMPLATES,
        config: {
          timeout: config.timeout,
          defaultFormat: config.defaultFormat,
          overwriteByDefault: config.overwriteByDefault,
          inputMethod: config.inputMethod,
          generateTemplate: config.generateTemplate,
        },
        notes: [
          "CRITICAL: Never read, cat, or open files that contain secrets. This would expose them in the AI context and defeat the purpose of nfi.",
          "Secret values are never returned in tool responses",
          "Use check_secret to verify a secret was written - never read the file directly",
          "store_secret returns a URL that the user must open to enter values",
          "The browser UI lets the user paste from a password manager; autofill is deliberately suppressed since the one-off URL never matches a saved login",
          "Dot notation is used for nested keys in structured formats (e.g., 'database.password')",
        ],
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(capabilities, null, 2),
        }],
      };
    },
  );

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
