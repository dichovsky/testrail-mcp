export type Command = 'help' | 'version' | 'serve' | 'invalid';

export function parseCommandLine(args: readonly string[]): Command {
  if (args.length === 0) return 'serve';
  if (args.length !== 1) return 'invalid';

  switch (args[0]) {
    case '--help':
    case '-h':
      return 'help';
    case '--version':
    case '-v':
      return 'version';
    default:
      return 'invalid';
  }
}
