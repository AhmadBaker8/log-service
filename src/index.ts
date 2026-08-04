import { loadConfig } from "./config/env";

/**
 * Temporary entrypoint. Verifies that configuration loads correctly.
 * Replaced with the real server bootstrap once the HTTP layer exists.
 */
function main(): void {
  const config = loadConfig();
  console.log("Configuration loaded:");
  console.log(`  port:           ${config.port}`);
  console.log(`  databaseUrl:    ${config.databaseUrl}`);
  console.log(`  authEnabled:    ${config.authEnabled}`);
  console.log(`  loadgenApiKey:  ${config.loadgenApiKey ?? "(none)"}`);
  console.log(`  retentionDays:  ${config.retentionDays}`);
}

main();
