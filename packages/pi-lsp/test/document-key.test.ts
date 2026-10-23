import assert from "node:assert/strict";
import { test } from "vitest";
import { documentKey } from "../src/document-key.js";

for (const [left, right] of [
  ["file:///tmp/a-b.ts", "file:///tmp/a%2Db.ts"],
  ["file:///tmp/%E6%BC%A2%20%23%3F%25.ts", "file:///tmp/漢%20%23%3f%25.ts"],
  ["file:///C:/Dir/a.ts", "file:///c%3A/Dir/a.ts"],
  ["file://localhost/C:/Dir/a.ts", "file:///c%3a/Dir/a.ts"],
  ["file://SERVER/share/a-b.ts", "file://server/share/a%2db.ts"],
]) {
  test(`equivalent file keys: ${left}`, () => assert.equal(documentKey(left), documentKey(right)));
}

test("reserved filename characters are not URI syntax or double decoded", () => {
  const uris = [
    "file:///tmp/a%23b.ts",
    "file:///tmp/a#b.ts",
    "file:///tmp/a%3Fb.ts",
    "file:///tmp/a?b.ts",
    "file:///tmp/a%25b.ts",
    "file:///tmp/a%2523b.ts",
    "file:///tmp/A.ts",
    "file:///tmp/a.ts",
    "file:///C:/Dir/a.ts",
    "file:///C:/dir/a.ts",
  ];
  assert.equal(new Set(uris.map(documentKey)).size, uris.length);
});

test("non-file and malformed URIs keep exact identity", () => {
  for (const uri of [
    "untitled:some%2Dname",
    "git:/A?x=%2f#%23",
    "https://EXAMPLE/a%2db",
    "not a URI",
    "file:///tmp/%zz",
    "file:///tmp/a%2Fb",
    "file:///tmp/a%5Cb",
  ]) {
    assert.equal(documentKey(uri), uri);
  }
});
