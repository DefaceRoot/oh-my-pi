#!/usr/bin/env bun
/**
 * Documentation automation CLI
 *
 * Commands:
 *   generate  - Generate documentation from source files
 *   watch     - Watch for file changes and regenerate docs
 *   verify    - Verify documentation is up-to-date
 */

import { parseArgs } from 'node:util';

interface CliArgs {
  command?: string;
  positionals: string[];
  values: Record<string, string | boolean>;
}

function parseCliArgs(): CliArgs {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      help: {
        type: 'boolean',
        short: 'h',
      },
      version: {
        type: 'boolean',
        short: 'v',
      },
      // Global options
      config: {
        type: 'string',
        short: 'c',
        description: 'Path to config file',
      },
      output: {
        type: 'string',
        short: 'o',
        description: 'Output directory',
      },
      verbose: {
        type: 'boolean',
        short: 'V',
        description: 'Verbose output',
      },
    },
  });

  const command = positionals[0];

  return { command, positionals, values };
}

function showHelp(): void {
  console.log(`
Documentation automation CLI

USAGE:
  omp-docs <command> [options]

COMMANDS:
  generate    Generate documentation from source files
  watch       Watch for file changes and regenerate docs
  verify      Verify documentation is up-to-date

OPTIONS:
  -c, --config <path>   Path to config file
  -o, --output <dir>    Output directory
  -V, --verbose         Verbose output
  -h, --help            Show this help message
  -v, --version         Show version

EXAMPLES:
  omp-docs generate
  omp-docs watch --output ./docs
  omp-docs verify --config docs.config.json
`);
}

function showVersion(): void {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  console.log(`omp-docs v${pkg.default.version}`);
}

async function handleGenerate(options: Record<string, string | boolean>): Promise<void> {
  console.log('Generating documentation...');
  if (options.verbose) console.log('Options:', options);
  // TODO: Implement generate logic
}

async function handleWatch(options: Record<string, string | boolean>): Promise<void> {
  console.log('Watching for changes...');
  if (options.verbose) console.log('Options:', options);
  // TODO: Implement watch logic
}

async function handleVerify(options: Record<string, string | boolean>): Promise<void> {
  console.log('Verifying documentation...');
  if (options.verbose) console.log('Options:', options);
  // TODO: Implement verify logic
}

async function main(): Promise<void> {
  const { command, positionals, values } = parseCliArgs();

  // Handle global flags
  if (values.help) {
    showHelp();
    process.exit(0);
  }

  if (values.version) {
    showVersion();
    process.exit(0);
  }

  // Handle commands
  switch (command) {
    case 'generate':
      await handleGenerate(values);
      break;
    case 'watch':
      await handleWatch(values);
      break;
    case 'verify':
      await handleVerify(values);
      break;
    case undefined:
      console.error('Error: No command specified\n');
      showHelp();
      process.exit(1);
    default:
      console.error(`Error: Unknown command '${command}'\n`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
