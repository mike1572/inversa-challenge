/**
 * Load environment for CLI scripts.
 *
 * Next loads .env.local automatically; plain tsx does not, and `dotenv/config`
 * only reads `.env`. Import this first in every script so the CLI and the app
 * read the same file.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
