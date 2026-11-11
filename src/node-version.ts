/** mcp-twake-ai and its dependencies need Node 22.13 or later. This module imports nothing: it must load on any Node. */
export const REQUIRED_NODE = '22.13';

export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = REQUIRED_NODE.split('.').map(Number);
  return major > needMajor || (major === needMajor && minor >= needMinor);
}
