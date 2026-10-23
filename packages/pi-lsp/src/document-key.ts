import path from "node:path";

/** File URL identity, independent of the OS running the client (including Windows drives). */
export function documentKey(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") return uri;
    // Encoded separators are not valid file URL path components. Never merge them
    // with real separators, or decode an escaped percent sign a second time.
    if (/%2f|%5c/i.test(url.pathname)) return uri;
    let pathname = path.posix.normalize(decodeURIComponent(url.pathname));
    pathname = pathname.replace(/^\/([A-Z]):(?=\/)/, (_match, drive: string) => `/${drive.toLowerCase()}:`);
    // Encode components, not the whole URI: literal #, ?, %, and Unicode remain
    // filename characters, not URI syntax. Only the drive letter is case folded.
    url.pathname = pathname.split("/").map(encodeURIComponent).join("/");
    return url.href;
  } catch {
    return uri;
  }
}
