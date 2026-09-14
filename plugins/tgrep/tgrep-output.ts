/** Extracts the first `:<line>:` delimiter after the filename, preserving colons in content. */
export function tgrepLocation(line: string): string {
  const delimiter = /^(.+?):(\d+):/.exec(line)
  return delimiter ? `${delimiter[1]}:${delimiter[2]}` : line
}
